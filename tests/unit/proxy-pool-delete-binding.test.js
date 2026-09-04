// Phase 01 (P3): DELETE /api/proxy-pools/[id] must refuse while a provider
// strategy still binds the pool; {force:true} unbinds then deletes.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => new Response(JSON.stringify(body), init),
  },
}), { virtual: true });

vi.mock("@/models", () => ({
  deleteProxyPool: vi.fn(async (id) => ({ id })),
  getProviderConnections: vi.fn(async () => []),
  getProxyPoolById: vi.fn(),
  updateProxyPool: vi.fn(async () => null),
}));
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(async () => ({})),
}));
vi.mock("@/lib/proxy/parseProxy", () => ({ normalizeProxyInput: vi.fn() }));
vi.mock("@/lib/proxy/providers/proxyxoayManager.js", () => ({
  registerPool: vi.fn(),
  unregisterPool: vi.fn(),
}));

import { deleteProxyPool, getProxyPoolById, getProviderConnections } from "@/models";
import { getSettings, updateSettings } from "@/lib/localDb";
import { DELETE } from "@/app/api/proxy-pools/[id]/route.js";

function poolRow() {
  return { id: "pool-1", name: "p", type: "http", isActive: true };
}

function requestWith(body) {
  return { json: async () => body };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getProxyPoolById).mockResolvedValue(poolRow());
  vi.mocked(getProviderConnections).mockResolvedValue([]);
});

describe("DELETE with providerStrategy binding (P3)", () => {
  it("returns 409 listing bound providers and does not delete", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      providerStrategies: {
        "kilocode": { proxyPoolId: "pool-1", rotateStrategy: "none" },
        "claude": { proxyPoolId: "other-pool" },
      },
    });
    const res = await DELETE(requestWith(null), { params: Promise.resolve({ id: "pool-1" }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.boundProviders).toEqual(["kilocode"]);
    expect(body.hint).toContain("force");
    expect(deleteProxyPool).not.toHaveBeenCalled();
  });

  it("force=true unbinds strategies then deletes", async () => {
    const settings = { providerStrategies: { "kilocode": { proxyPoolId: "pool-1", rotateStrategy: "random" } } };
    vi.mocked(getSettings).mockResolvedValue(settings);
    const res = await DELETE(requestWith({ force: true }), { params: Promise.resolve({ id: "pool-1" }) });
    expect(res.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      providerStrategies: { "kilocode": { proxyPoolId: "__none__", rotateStrategy: "random" } },
    });
    expect(deleteProxyPool).toHaveBeenCalledWith("pool-1");
  });

  it("unbound pool deletes without touching settings", async () => {
    vi.mocked(getSettings).mockResolvedValue({ providerStrategies: {} });
    const res = await DELETE(requestWith(null), { params: Promise.resolve({ id: "pool-1" }) });
    expect(res.status).toBe(200);
    expect(updateSettings).not.toHaveBeenCalled();
    expect(deleteProxyPool).toHaveBeenCalledWith("pool-1");
  });

  it("connection binding still returns 409 even with force", async () => {
    vi.mocked(getSettings).mockResolvedValue({ providerStrategies: { "kilocode": { proxyPoolId: "pool-1" } } });
    vi.mocked(getProviderConnections).mockResolvedValue([
      { id: "c1", providerSpecificData: { proxyPoolId: "pool-1" } },
    ]);
    const res = await DELETE(requestWith({ force: true }), { params: Promise.resolve({ id: "pool-1" }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.boundConnectionCount).toBe(1);
    expect(deleteProxyPool).not.toHaveBeenCalled();
  });

  it("409 body exposes provider names only — never credentials", async () => {
    vi.mocked(getSettings).mockResolvedValue({
      providerStrategies: { "kilocode": { proxyPoolId: "pool-1", apiKey: "sk-secret" } },
    });
    const res = await DELETE(requestWith(null), { params: Promise.resolve({ id: "pool-1" }) });
    const text = await res.text();
    expect(text).not.toContain("sk-secret");
  });
});
