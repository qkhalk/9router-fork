// Per-subscription sync semantics + next-run scheduler (Phase 2).
//
// Body-cap note: the module reads XRAY_SYNC_MAX_BODY_BYTES (production
// default 50 MB) at import time — this file sets it to 1024 so the
// byte-cap abort is testable without allocating 50 MB, while normal
// link fixtures (a few hundred bytes) flow through untouched.
process.env.XRAY_SYNC_MAX_BODY_BYTES = "1024";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

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
  // Mimics the repo: stamping sync state advances lastSyncAt, which is what
  // the scheduler's next-due computation reads.
  setSubSyncState: vi.fn(async (id, patch) => {
    const s = mocks.subs.find((x) => x.id === id);
    if (s) {
      s.lastSyncAt = new Date().toISOString();
      s.lastSyncCount = patch?.lastSyncCount ?? s.lastSyncCount;
      s.lastSyncError = patch?.lastSyncError ?? null;
    }
    return s;
  }),
  setSubUserinfo: vi.fn(),
  listSubs: vi.fn(async () => mocks.subs),
  getSub: vi.fn(async (id) => mocks.subs.find((s) => s.id === id) ?? null),
}));

vi.mock("../../src/lib/db/repos/xrayRepo.js", () => ({
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
    ...actual, // real pure resolvers (interval/retention clamps)
    listXraySubscriptions: mocks.listSubs,
    getXraySubscription: mocks.getSub,
    setXraySubscriptionSyncState: mocks.setSubSyncState,
    setXraySubscriptionUserinfo: mocks.setSubUserinfo,
  };
});
vi.mock("../../src/lib/db/repos/settingsRepo.js", () => ({
  getSettings: vi.fn(async () => ({ xrayStaleRetentionDays: 7, xraySyncIntervalMin: 60 })),
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

const sync = await import("../../src/lib/xray/sync.js");
const { resolveIntervalMin, MAX_SUB_INTERVAL_MIN } = await import("../../src/lib/db/repos/subscriptionRepo.js");

const SUB_A = { id: 1, name: "Airport A", url: "https://a.example.com/sub", enabled: true, intervalMin: 60, retentionDays: 7 };
const SUB_B = { id: 2, name: "Airport B", url: "https://b.example.com/sub", enabled: true, intervalMin: 60, retentionDays: 7 };

const LINK_A1 = "vless://uuid-a@a1.example.com:443?type=tcp#node-a1";
const LINK_A2 = "vless://uuid-a@a2.example.com:443?type=tcp#node-a2";
const LINK_B1 = "vless://uuid-b@b1.example.com:443?type=tcp#node-b1";
// syncParse hashes the CANONICAL link (fragment stripped) — mirror that here.
const ID = (link) => createHash("sha1").update(link.slice(0, link.indexOf("#"))).digest("hex");

function stubFetchQueue() {
  const queue = [];
  globalThis.fetch = vi.fn(() => {
    const next = queue.shift();
    return Promise.resolve(next());
  });
  return queue;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete globalThis.fetch;
  mocks.subs = [];
  mocks.countSubMemberships.mockResolvedValue(0);
  mocks.removeMissingMemberships.mockResolvedValue([]);
  mocks.getConfigIdsWithNoMembership.mockResolvedValue([]);
});

afterEach(() => {
  sync.stopSyncScheduler();
  vi.useRealTimers();
});

describe("cross-sub isolation", () => {
  it("config dropped by A but still carried by B is NOT deactivated", async () => {
    const idA1 = ID(LINK_A1);
    const idA2 = ID(LINK_A2); // dropped by A, still carried by B
    mocks.subs = [{ ...SUB_A }];
    mocks.countSubMemberships.mockResolvedValue(2); // A currently carries a1+a2
    mocks.removeMissingMemberships.mockResolvedValue([idA2]); // A dropped a2
    mocks.getConfigIdsWithNoMembership.mockResolvedValue([]); // B still carries a2
    stubFetchQueue().push(() => new Response(`${LINK_A1}\n`, { status: 200 }));

    const res = await sync.syncSubscription({});
    expect(res.results[0].aborted).toBeUndefined();
    expect(mocks.deactivate).not.toHaveBeenCalledWith(expect.arrayContaining([idA2]));
    expect(mocks.deactivate).not.toHaveBeenCalled();
  });

  it("config whose LAST membership vanished is deactivated on the losing sub's retention", async () => {
    const idA2 = ID(LINK_A2);
    mocks.subs = [{ ...SUB_A, retentionDays: 3 }];
    mocks.countSubMemberships.mockResolvedValue(2);
    mocks.removeMissingMemberships.mockResolvedValue([idA2]);
    mocks.getConfigIdsWithNoMembership.mockResolvedValue([idA2]); // nobody carries it anymore
    stubFetchQueue().push(() => new Response(`${LINK_A1}\n`, { status: 200 }));

    await sync.syncSubscription({});
    expect(mocks.deactivate).toHaveBeenCalledTimes(1);
    const [ids, horizon] = mocks.deactivate.mock.calls[0];
    expect(ids).toEqual([idA2]);
    // horizon ≈ now + 3 days (between +2.9 and +3.1 days)
    const deltaDays = (Date.parse(horizon) - Date.now()) / 86400000;
    expect(deltaDays).toBeGreaterThan(2.9);
    expect(deltaDays).toBeLessThan(3.1);
  });

  it("syncing sub A never touches sub B's memberships (sequential all-subs run)", async () => {
    mocks.subs = [{ ...SUB_A }, { ...SUB_B }];
    stubFetchQueue().push(
      () => new Response(`${LINK_A1}\n${LINK_A2}\n`, { status: 200 }),
      () => new Response(`${LINK_B1}\n`, { status: 200 })
    );

    const res = await sync.syncSubscription({});
    expect(res.results).toHaveLength(2);
    expect(res.results[0].count).toBe(2);
    expect(res.results[1].count).toBe(1);
    // Each sub upserts ITS OWN memberships under its own id.
    expect(mocks.upsertMemberships).toHaveBeenCalledWith(1, [ID(LINK_A1), ID(LINK_A2)], expect.any(String));
    expect(mocks.upsertMemberships).toHaveBeenCalledWith(2, [ID(LINK_B1)], expect.any(String));
  });
});

describe("per-sub failure isolation", () => {
  it("sub A aborts (empty-parse) while sub B syncs normally", async () => {
    mocks.subs = [{ ...SUB_A }, { ...SUB_B }];
    mocks.countSubMemberships.mockResolvedValueOnce(50).mockResolvedValueOnce(0);
    stubFetchQueue().push(
      () => new Response("<html>portal</html>", { status: 200 }),
      () => new Response(`${LINK_B1}\n`, { status: 200 })
    );

    const res = await sync.syncSubscription({});
    expect(res.results[0].aborted).toBe("empty-parse");
    expect(res.results[1].aborted).toBeUndefined();
    expect(res.results[1].count).toBe(1);
  });

  it("shrink-guard: 4-of-400 fetch aborts that sub only", async () => {
    mocks.subs = [{ ...SUB_A }];
    mocks.countSubMemberships.mockResolvedValue(400);
    stubFetchQueue().push(() => new Response(`${LINK_A1}\n${LINK_A2}\n${LINK_B1}\nvless://x@y:1#z\n`, { status: 200 }));

    const res = await sync.syncSubscription({});
    expect(res.results[0].aborted).toBe("shrink-guard");
    expect(res.results[0].error).toContain("shrink-guard");
    expect(mocks.bulkUpsert).not.toHaveBeenCalled();
    expect(mocks.deactivate).not.toHaveBeenCalled();
  });

  it("unknown subscriptionId → error result with unknownSubscriptionId marker", async () => {
    mocks.getSub.mockResolvedValue(null);
    const res = await sync.syncSubscription({ subscriptionId: 99 });
    expect(res.unknownSubscriptionId).toBe(99);
    expect(res.results).toEqual([]);
    expect(globalThis.fetch).toBeUndefined();
  });
});

describe("tombstones are never resurrected or swept", () => {
  it("tombstoned id reappearing in the fetch is filtered from upsert + membership", async () => {
    const idA1 = ID(LINK_A1);
    const idTomb = ID(LINK_A2);
    mocks.subs = [{ ...SUB_A }];
    mocks.getTombstonedConfigIds.mockResolvedValue([idTomb]);
    stubFetchQueue().push(() => new Response(`${LINK_A1}\n${LINK_A2}\n`, { status: 200 }));

    await sync.syncOneSubscription({ ...SUB_A }, {}, "manual-sync");
    const upsertEntries = mocks.bulkUpsert.mock.calls[0][0];
    expect(upsertEntries.map((e) => e.id)).toEqual([idA1]); // tomb excluded
    expect(mocks.upsertMemberships.mock.calls[0][1]).toEqual([idA1]);
  });
});

describe("userinfo persistence", () => {
  it("header present → sub row gets traffic/expiry; header absent → untouched", async () => {
    mocks.subs = [{ ...SUB_A }];
    stubFetchQueue().push(
      () => new Response(`${LINK_A1}\n`, {
        status: 200,
        headers: { "subscription-userinfo": "upload=1000; download=2000; total=10000; expire=1798761600" },
      }),
      () => new Response(`${LINK_A1}\n`, { status: 200 })
    );

    await sync.syncSubscription({});
    expect(mocks.setSubUserinfo).toHaveBeenCalledTimes(1);
    expect(mocks.setSubUserinfo).toHaveBeenCalledWith(1, expect.objectContaining({
      uploadBytes: 1000, downloadBytes: 2000, totalBytes: 10000,
      expireAt: new Date(1798761600 * 1000).toISOString(),
    }));
  });
});

describe("per-sub single-flight (RT-13)", () => {
  it("concurrent same-sub syncs queue instead of interleaving", async () => {
    const deferreds = [];
    globalThis.fetch = vi.fn(
      () => new Promise((resolve) => deferreds.push(resolve))
    );
    mocks.subs = [{ ...SUB_A }];

    const p1 = sync.syncOneSubscription({ ...SUB_A }, {}, "scheduled-sync");
    const p2 = sync.syncOneSubscription({ ...SUB_A }, {}, "manual-sync");
    await Promise.resolve();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // second queued behind first

    deferreds[0](new Response(`${LINK_A1}\n`, { status: 200 }));
    await p1;
    await new Promise((r) => setTimeout(r, 0));
    expect(globalThis.fetch).toHaveBeenCalledTimes(2); // now the queued sync runs
    deferreds[1](new Response(`${LINK_A1}\n`, { status: 200 }));
    const r2 = await p2;
    expect(r2.count).toBe(1);
    expect(sync.isSubscriptionSyncInFlight(SUB_A.id)).toBe(false);
  });
});

describe("byte-cap abort (Sec-5)", () => {
  it("oversized body aborts the sync with an error, no wipe", async () => {
    mocks.subs = [{ ...SUB_A }];
    mocks.countSubMemberships.mockResolvedValue(5);
    stubFetchQueue().push(() => new Response("x".repeat(2000), { status: 200 })); // > 1024-byte test cap

    const res = await sync.syncSubscription({});
    expect(res.results[0].error).toContain("cap");
    expect(mocks.bulkUpsert).not.toHaveBeenCalled();
  });
});

describe("scheduler next-run computation (RT-11)", () => {
  it("zero eligible subs arms no timer", async () => {
    vi.useFakeTimers();
    mocks.subs = [{ ...SUB_A, intervalMin: 0 }]; // manual-only
    const next = await sync.scheduleNext();
    expect(next).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("earliest-due sub is scheduled first; interval floor and ceiling enforced", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
    mocks.subs = [
      { ...SUB_A, intervalMin: 60, lastSyncAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }, // due now
      { ...SUB_B, intervalMin: 60, lastSyncAt: new Date(Date.now() - 1 * 60 * 1000).toISOString() },  // due in 59 min
    ];
    const next = await sync.scheduleNext();
    expect(next.subscriptionId).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    // Fire: A syncs (fetch #1), B does not (not due); scheduler re-arms for B.
    const queue = [];
    globalThis.fetch = vi.fn(() => {
      const next = queue.shift();
      return Promise.resolve(next());
    });
    queue.push(() => new Response(`${LINK_A1}\n`, { status: 200 }));
    mocks.listSubs.mockImplementation(async () => mocks.subs);
    await vi.advanceTimersByTimeAsync(1000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // B becomes due ~59 min later.
    queue.push(() => new Response(`${LINK_B1}\n`, { status: 200 }));
    await vi.advanceTimersByTimeAsync(59 * 60 * 1000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("30-day custom interval clamps to the 14-day ceiling (setTimeout storm guard)", () => {
    expect(MAX_SUB_INTERVAL_MIN).toBe(20160);
    expect(resolveIntervalMin({ intervalMin: 43200 }, 60)).toBe(20160); // 30d → 14d
    expect(resolveIntervalMin({ intervalMin: 3 }, 60)).toBe(5); // floor
    expect(resolveIntervalMin({ intervalMin: 0 }, 60)).toBe(0); // manual honored
    expect(resolveIntervalMin({ intervalMin: null }, 42)).toBe(42); // legacy fallback
  });

  it("CRUD-triggered restart recomputes (idempotent startSyncScheduler)", async () => {
    vi.useFakeTimers();
    mocks.subs = [{ ...SUB_A, intervalMin: 60, lastSyncAt: null }]; // never synced → due now
    await sync.startSyncScheduler();
    const timersAfterFirst = vi.getTimerCount(); // boot timer + next timer
    await sync.startSyncScheduler();
    expect(vi.getTimerCount()).toBe(timersAfterFirst); // no leak — old timers cleared
  });
});
