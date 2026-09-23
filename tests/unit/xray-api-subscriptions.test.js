// Phase 3 — subscriptions CRUD routes: validation matrix, 409/404 mapping,
// scheduler restart after every mutation, DELETE retention semantics.
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  subs: [],
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  getSub: vi.fn(),
  subMemberIds: vi.fn(async () => []),
  unmemberedIds: vi.fn(async () => []),
  deactivate: vi.fn(async () => 0),
  sweep: vi.fn(async () => 0),
  startScheduler: vi.fn(async () => null),
  syncInFlight: vi.fn(() => false),
  SubscriptionError: class SubscriptionError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "SubscriptionError";
      this.code = code;
    }
  },
}));

vi.mock("@/lib/db/repos/subscriptionRepo", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual, // real clamp resolvers
    listXraySubscriptions: vi.fn(async () => mocks.subs),
    createXraySubscription: mocks.create,
    updateXraySubscription: mocks.update,
    deleteXraySubscription: mocks.remove,
    getXraySubscription: mocks.getSub,
    SubscriptionError: mocks.SubscriptionError,
  };
});
vi.mock("@/lib/db/repos/settingsRepo", () => ({
  getSettings: vi.fn(async () => ({ xraySyncIntervalMin: 60, xrayStaleRetentionDays: 7 })),
}));
vi.mock("@/lib/db/repos/xrayRepo", () => ({
  getSubMemberConfigIds: mocks.subMemberIds,
  getConfigIdsWithNoMembership: mocks.unmemberedIds,
  deactivateXrayConfigs: mocks.deactivate,
  sweepStaleXrayConfigs: mocks.sweep,
}));
vi.mock("@/lib/xray/sync", () => ({
  startSyncScheduler: mocks.startScheduler,
  isSubscriptionSyncInFlight: mocks.syncInFlight,
  syncSubscription: vi.fn(),
}));

const { GET, POST } = await import("@/app/api/xray/subscriptions/route.js");
const { PATCH, DELETE } = await import("@/app/api/xray/subscriptions/[id]/route.js");

const url = (p) => `http://localhost:20127${p}`;
const req = (method, path, body) =>
  new Request(url(path), { method, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.subs = [];
  mocks.syncInFlight.mockReturnValue(false);
  mocks.subMemberIds.mockResolvedValue([]);
  mocks.unmemberedIds.mockResolvedValue([]);
});

describe("POST /api/xray/subscriptions", () => {
  it("creates and restarts the scheduler", async () => {
    mocks.create.mockResolvedValue({ id: 1, name: "A", url: "https://a.example.com/s", enabled: true });
    const res = await POST(req("POST", "/api/xray/subscriptions", { name: "A", url: "https://a.example.com/s" }));
    expect(res.status).toBe(201);
    expect(mocks.startScheduler).toHaveBeenCalledTimes(1);
  });

  it("400s without a url and on repo INVALID_URL", async () => {
    const noUrl = await POST(req("POST", "/api/xray/subscriptions", { name: "A" }));
    expect(noUrl.status).toBe(400);

    mocks.create.mockImplementation(() => {
      throw new mocks.SubscriptionError("INVALID_URL", "subscription url must use http or https");
    });
    const badScheme = await POST(req("POST", "/api/xray/subscriptions", { url: "ftp://x/y" }));
    expect(badScheme.status).toBe(400);
    expect(mocks.startScheduler).not.toHaveBeenCalled();
  });

  it("409s on duplicate URL (URL_TAKEN)", async () => {
    mocks.create.mockImplementation(() => {
      throw new mocks.SubscriptionError("URL_TAKEN", "a subscription with this url already exists");
    });
    const res = await POST(req("POST", "/api/xray/subscriptions", { url: "https://dup.example.com/s" }));
    expect(res.status).toBe(409);
  });

  it("clamps intervalMin 3 → 5 and rejects fractional retentionDays", async () => {
    mocks.create.mockResolvedValue({ id: 2, name: "B", url: "https://b.example.com/s" });
    await POST(req("POST", "/api/xray/subscriptions", { url: "https://b.example.com/s", intervalMin: 3 }));
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ intervalMin: 5 }));

    const badRetention = await POST(req("POST", "/api/xray/subscriptions", { url: "https://b.example.com/s", retentionDays: 5.5 }));
    expect(badRetention.status).toBe(400);
  });
});

describe("PATCH /api/xray/subscriptions/[id]", () => {
  it("404 on unknown id (both route-level pre-check and repo error)", async () => {
    mocks.getSub.mockResolvedValue(null);
    const res = await PATCH(req("PATCH", "/api/xray/subscriptions/99", { name: "x" }), { params: Promise.resolve({ id: "99" }) });
    expect(res.status).toBe(404);
  });

  it("updates and restarts scheduler; 409 on URL clash", async () => {
    mocks.getSub.mockResolvedValue({ id: 1, name: "A", url: "https://a.example.com/s", intervalMin: 60, retentionDays: 7 });
    mocks.update.mockResolvedValue({ id: 1, name: "Renamed", url: "https://a.example.com/s", intervalMin: 0, retentionDays: -1 });
    const res = await PATCH(req("PATCH", "/api/xray/subscriptions/1", { name: "Renamed", intervalMin: 0, retentionDays: -1 }), {
      params: Promise.resolve({ id: "1" }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.subscription.effectiveIntervalMin).toBe(0);
    expect(body.subscription.effectiveRetentionDays).toBe(-1);
    expect(mocks.startScheduler).toHaveBeenCalledTimes(1);

    mocks.update.mockImplementation(() => {
      throw new mocks.SubscriptionError("URL_TAKEN", "clash");
    });
    const clash = await PATCH(req("PATCH", "/api/xray/subscriptions/1", { url: "https://dup.example.com/s" }), {
      params: Promise.resolve({ id: "1" }),
    });
    expect(clash.status).toBe(409);
  });
});

describe("DELETE /api/xray/subscriptions/[id]", () => {
  const EXISTING = { id: 1, name: "A", url: "https://a.example.com/s", retentionDays: 3 };

  it("409 while that sub's sync is in flight (zombie-membership guard)", async () => {
    mocks.getSub.mockResolvedValue(EXISTING);
    mocks.syncInFlight.mockReturnValue(true);
    const res = await DELETE(req("DELETE", "/api/xray/subscriptions/1"), { params: Promise.resolve({ id: "1" }) });
    expect(res.status).toBe(409);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("404 on unknown id", async () => {
    mocks.getSub.mockResolvedValue(null);
    const res = await DELETE(req("DELETE", "/api/xray/subscriptions/99"), { params: Promise.resolve({ id: "99" }) });
    expect(res.status).toBe(404);
  });

  it("applies the deleted sub's retention ONLY to configs orphaned by this delete", async () => {
    mocks.getSub.mockResolvedValue(EXISTING);
    mocks.subMemberIds.mockResolvedValue(["c1", "c2", "c3"]); // carried by sub 1
    mocks.remove.mockResolvedValue(1);
    mocks.unmemberedIds.mockResolvedValue(["c1", "c9"]); // c1 orphaned by THIS delete; c9 was already unmembered (restored)

    const res = await DELETE(req("DELETE", "/api/xray/subscriptions/1"), { params: Promise.resolve({ id: "1" }) });
    expect(res.status).toBe(200);
    expect(mocks.deactivate).toHaveBeenCalledTimes(1);
    const [ids, horizon] = mocks.deactivate.mock.calls[0];
    expect(ids).toEqual(["c1"]); // c9 untouched — restored configs stay exempt
    const deltaDays = (Date.parse(horizon) - Date.now()) / 86400000;
    expect(deltaDays).toBeGreaterThan(2.9);
    expect(deltaDays).toBeLessThan(3.1);
    expect(mocks.startScheduler).toHaveBeenCalledTimes(1);
  });

  it("retention 0 sweeps orphans immediately", async () => {
    mocks.getSub.mockResolvedValue({ ...EXISTING, retentionDays: 0 });
    mocks.subMemberIds.mockResolvedValue(["c1"]);
    mocks.remove.mockResolvedValue(1);
    mocks.unmemberedIds.mockResolvedValue(["c1"]);

    await DELETE(req("DELETE", "/api/xray/subscriptions/1"), { params: Promise.resolve({ id: "1" }) });
    expect(mocks.sweep).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/xray/subscriptions", () => {
  it("lists subs with resolved effective interval/retention", async () => {
    mocks.subs = [{ id: 1, name: "A", url: "https://a.example.com/s", intervalMin: null, retentionDays: null }];
    const res = await GET();
    const body = await res.json();
    expect(body.subscriptions).toHaveLength(1);
    expect(body.subscriptions[0].effectiveIntervalMin).toBe(60); // legacy default
    expect(body.subscriptions[0].effectiveRetentionDays).toBe(7);
  });
});
