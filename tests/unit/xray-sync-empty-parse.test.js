// Phase 02 (X2), per-subscription edition: an HTTP 200 body that parses to
// ZERO links must never wipe THAT subscription's memberships — and only that
// sub's sync aborts; other subs and already-inactive configs are untouched.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  subs: [],
  bulkUpsert: vi.fn(async (entries) => entries.length),
  upsertMemberships: vi.fn(async () => 0),
  removeMissingMemberships: vi.fn(async () => []),
  getConfigIdsWithNoMembership: vi.fn(async () => []),
  getTombstonedConfigIds: vi.fn(async () => []),
  countSubMemberships: vi.fn(async () => 0),
  deactivate: vi.fn(async () => 0),
  sweep: vi.fn(async () => 0),
  setSyncState: vi.fn(),
  setSubSyncState: vi.fn(),
  setSubUserinfo: vi.fn(),
}));

vi.mock("../../src/lib/db/repos/xrayRepo.js", () => ({
  // sync.js also dynamic-imports these two from this module.
  getSelectedXrayConfig: vi.fn(async () => null),
  setSelectedXrayConfig: vi.fn(),
  bulkUpsertXrayConfigs: mocks.bulkUpsert,
  upsertMemberships: mocks.upsertMemberships,
  removeMissingMemberships: mocks.removeMissingMemberships,
  getConfigIdsWithNoMembership: mocks.getConfigIdsWithNoMembership,
  getTombstonedConfigIds: mocks.getTombstonedConfigIds,
  countSubMemberships: mocks.countSubMemberships,
  deactivateXrayConfigs: mocks.deactivate,
  sweepStaleXrayConfigs: mocks.sweep,
  getXraySyncState: vi.fn(async () => ({})),
  setXraySyncState: mocks.setSyncState,
}));
vi.mock("../../src/lib/db/repos/subscriptionRepo.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual, // keep the pure resolvers real
    listXraySubscriptions: vi.fn(async () => mocks.subs),
    getXraySubscription: vi.fn(async (id) => mocks.subs.find((s) => s.id === id) ?? null),
    setXraySubscriptionSyncState: mocks.setSubSyncState,
    setXraySubscriptionUserinfo: mocks.setSubUserinfo,
  };
});
vi.mock("../../src/lib/db/repos/settingsRepo.js", () => ({
  getSettings: vi.fn(async () => ({ xrayStaleRetentionDays: 0 })),
  updateSettings: vi.fn(),
}));
vi.mock("../../src/lib/db/repos/modelFilterResultsRepo.js", () => ({
  pruneOrphanModelFilterResults: vi.fn(async () => {}),
}));
vi.mock("../../src/lib/xray/apiFilter.js", () => ({
  maybeRunModelFilterAfterSync: vi.fn(async () => null),
  startFilterXray: vi.fn(),
  stopFilterXray: vi.fn(),
  probeConfigViaApi: vi.fn(),
}));

const { syncSubscription } = await import("../../src/lib/xray/sync.js");

const DEFAULT_SUB = { id: 1, name: "Default", url: "https://sub.example.com/all.txt", enabled: true, intervalMin: 60, retentionDays: 7 };

function stubFetch(body, status = 200) {
  globalThis.fetch = vi.fn(async () => new Response(body, { status }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.subs = [{ ...DEFAULT_SUB }];
  mocks.countSubMemberships.mockResolvedValue(0);
});

describe("empty-parse guard (X2, per-sub)", () => {
  it("HTML body over sub with memberships → abort that sub, rows preserved", async () => {
    mocks.countSubMemberships.mockResolvedValue(2);
    stubFetch("<html><body>Subscription not found</body></html>");

    const res = await syncSubscription({});

    expect(res.results).toHaveLength(1);
    expect(res.results[0].aborted).toBe("empty-parse");
    expect(res.results[0].error).toContain("0 parseable links");
    // The wipe path must never run.
    expect(mocks.bulkUpsert).not.toHaveBeenCalled();
    expect(mocks.upsertMemberships).not.toHaveBeenCalled();
    expect(mocks.deactivate).not.toHaveBeenCalled();
    expect(mocks.sweep).not.toHaveBeenCalled();
    // Abort recorded on the SUB row (per-sub truth) and aggregated.
    expect(mocks.setSubSyncState).toHaveBeenCalledWith(1, expect.objectContaining({
      lastSyncError: expect.stringContaining("fail-closed"),
    }));
  });

  it("empty body over sub with memberships → abort", async () => {
    mocks.countSubMemberships.mockResolvedValue(1);
    stubFetch("");
    const res = await syncSubscription({});
    expect(res.results[0].aborted).toBe("empty-parse");
    expect(mocks.deactivate).not.toHaveBeenCalled();
  });

  it("zero links over a sub with NO memberships → proceeds (fresh install)", async () => {
    stubFetch("no links here");
    const res = await syncSubscription({});
    expect(res.results[0].aborted).toBeUndefined();
    expect(mocks.bulkUpsert).toHaveBeenCalledWith([]);
    expect(mocks.upsertMemberships).toHaveBeenCalledWith(1, [], expect.any(String));
  });

  it("healthy subscription → upsert + membership + sweep path", async () => {
    mocks.removeMissingMemberships.mockResolvedValue(["stale-id"]);
    mocks.getConfigIdsWithNoMembership.mockResolvedValue(["stale-id"]);
    stubFetch("vless://uuid@host:443?type=tcp#node-a\n");
    const res = await syncSubscription({});
    expect(res.results[0].aborted).toBeUndefined();
    expect(res.results[0].count).toBe(1);
    expect(mocks.bulkUpsert).toHaveBeenCalled();
    expect(mocks.upsertMemberships).toHaveBeenCalledWith(1, [expect.any(String)], expect.any(String));
    expect(mocks.deactivate).toHaveBeenCalledWith(["stale-id"], expect.any(String));
    expect(mocks.sweep).toHaveBeenCalledWith(expect.any(String));
  });

  it("HTTP error → fetch-error path on that sub, no wipe", async () => {
    mocks.countSubMemberships.mockResolvedValue(1);
    stubFetch("gateway timeout", 502);
    const res = await syncSubscription({});
    expect(res.results[0].error).toContain("502");
    expect(mocks.deactivate).not.toHaveBeenCalled();
  });
});
