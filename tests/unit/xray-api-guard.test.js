// Phase 3 / RT-7 — REAL guard behavior for the new routes (no list-membership
// assertions): unauthenticated requests are rejected, LOCAL_ONLY routes stay
// loopback-gated, and the deny-by-default /api/* fallthrough covers the
// version endpoints. Harness mocks dashboardGuard's auth backends only.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  requireLogin: true,
  tokenValid: false,
  cliToken: "cafebabe".repeat(8),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ requireLogin: state.requireLogin })),
  validateApiKey: vi.fn(async () => false),
}));
vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: vi.fn(async () => state.cliToken),
}));
vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: vi.fn(async (t) => state.tokenValid && t === "good-token"),
}));
vi.mock("@/lib/auth/tunnelAccess", () => ({
  isKnownTunnelHost: vi.fn(async () => false),
}));

const { proxy, __test__ } = await import("@/dashboardGuard");

const req = (path, opts = {}) =>
  new NextRequest(`http://127.0.0.1:20127${path}`, {
    // host must be set explicitly: undici stamps Host at send-time, not in
    // the headers object, and the guard's locality checks read the header.
    headers: { host: "127.0.0.1:20127", origin: "http://127.0.0.1:20127", ...(opts.headers || {}) },
  });

beforeEach(() => {
  state.requireLogin = true;
  state.tokenValid = false;
});

describe("guard tiers for new xray routes (RT-7)", () => {
  it("unauthenticated /api/xray/version/latest → 401 (default-deny auth fallthrough)", async () => {
    const res = await proxy(req("/api/xray/version/latest"));
    expect(res.status).toBe(401);
  });

  it("unauthenticated LOCAL_ONLY routes (subscriptions/sync) → rejected as local-only", async () => {
    for (const p of ["/api/xray/subscriptions", "/api/xray/sync"]) {
      const res = await proxy(req(p, { method: "POST" }));
      expect([401, 403]).toContain(res.status);
    }
  });

  it("loopback with requireLogin=false passes LOCAL_ONLY (same tier as /api/xray/install)", async () => {
    // isLoopbackPeer (requestLocality) treats the spoofable Host header as a
    // loopback peer only under `next dev` — mirror that environment here.
    vi.stubEnv("NODE_ENV", "development");
    state.requireLogin = false;
    for (const p of ["/api/xray/subscriptions", "/api/xray/sync", "/api/xray/install", "/api/xray/version/latest"]) {
      const res = await proxy(req(p, { method: p === "/api/xray/version/latest" ? "GET" : "POST" }));
      // next() returns a non-error response (NextResponse.next() → 200 surface)
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    }
    vi.unstubAllEnvs();
  });

  it("config tombstone/restore inherits LOCAL_ONLY via the /api/xray/configs/ prefix", async () => {
    // Non-loopback host + requireLogin=false: LOCAL_ONLY must still reject.
    state.requireLogin = false;
    const remote = new NextRequest("http://203.0.113.7:20127/api/xray/configs/abc", {
      method: "DELETE",
      headers: { host: "203.0.113.7:20127" },
    });
    const res = await proxy(remote);
    expect(res.status).toBe(403);
  });

  it("isLocalRequest and tier helpers stay exported for consumers", () => {
    expect(typeof __test__.isLocalRequest).toBe("function");
    expect(typeof __test__.canAccessLocalOnlyRoute).toBe("function");
  });
});
