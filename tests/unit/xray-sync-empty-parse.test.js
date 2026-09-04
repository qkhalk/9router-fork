// Phase 02 (X2): sync must be fail-closed — an HTTP 200 body that parses to
// ZERO links must never deactivate/delete a non-empty config catalog.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activeRows: [],
  markStale: vi.fn(),
  cleanupStale: vi.fn(),
  bulkUpsert: vi.fn(async (entries) => entries.length),
  setSyncState: vi.fn(),
  getSelectedBeforeSync: vi.fn(async () => null),
}));

vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: vi.fn() }));
vi.mock("../../src/lib/db/repos/xrayRepo.js", () => ({
  // sync.js also dynamic-imports getSelectedXrayConfig from this module.
  getSelectedXrayConfig: vi.fn(async () => null),
  bulkUpsertXrayConfigs: mocks.bulkUpsert,
  markStaleXrayConfigs: mocks.markStale,
  cleanupStaleXrayConfigs: mocks.cleanupStale,
  getXrayConfigs: vi.fn(async () => mocks.activeRows),
  getXraySyncState: vi.fn(async () => ({})),
  setXraySyncState: mocks.setSyncState,
  getSelectedBeforeSync: mocks.getSelectedBeforeSync,
  setSelectedXrayConfig: vi.fn(),
}));
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

function stubFetch(body, status = 200) {
  globalThis.fetch = vi.fn(async () => new Response(body, { status }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeRows = [];
});

describe("empty-parse guard (X2)", () => {
  it("HTML body over non-empty catalog → abort, rows preserved", async () => {
    mocks.activeRows = [{ id: "cfg-1" }, { id: "cfg-2" }];
    stubFetch("<html><body>Subscription not found</body></html>");

    const res = await syncSubscription({});

    expect(res.aborted).toBe("empty-parse");
    expect(res.error).toContain("0 parseable links");
    // The wipe path must never run.
    expect(mocks.markStale).not.toHaveBeenCalled();
    expect(mocks.bulkUpsert).not.toHaveBeenCalled();
    expect(mocks.cleanupStale).not.toHaveBeenCalled();
    expect(mocks.setSyncState).toHaveBeenCalledWith(expect.objectContaining({
      lastSyncError: expect.stringContaining("fail-closed"),
    }));
  });

  it("empty body over non-empty catalog → abort", async () => {
    mocks.activeRows = [{ id: "cfg-1" }];
    stubFetch("");
    const res = await syncSubscription({});
    expect(res.aborted).toBe("empty-parse");
    expect(mocks.markStale).not.toHaveBeenCalled();
  });

  it("zero links over an ALREADY-EMPTY catalog → proceeds (fresh install)", async () => {
    mocks.activeRows = [];
    stubFetch("no links here");
    const res = await syncSubscription({});
    expect(res.aborted).toBeUndefined();
    expect(mocks.markStale).toHaveBeenCalledWith([]);
  });

  it("healthy subscription → normal upsert + stale-mark path", async () => {
    mocks.activeRows = [{ id: "old" }];
    stubFetch("vless://uuid@host:443?type=tcp#node-a\n");
    const res = await syncSubscription({});
    expect(res.aborted).toBeUndefined();
    expect(mocks.bulkUpsert).toHaveBeenCalled();
    expect(mocks.markStale).toHaveBeenCalled();
  });

  it("HTTP error → fetch-error path, no wipe", async () => {
    mocks.activeRows = [{ id: "cfg-1" }];
    stubFetch("gateway timeout", 502);
    const res = await syncSubscription({});
    expect(res.error).toContain("502");
    expect(mocks.markStale).not.toHaveBeenCalled();
  });
});
