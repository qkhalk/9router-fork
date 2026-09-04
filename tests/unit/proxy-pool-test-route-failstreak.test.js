// Phase 01 (P1/N1/N2): proxy-pool test route — deactivation requires a
// 3-failure streak, "no entries" never deactivates, managed pools are exempt,
// and entry cooldowns go through the transactional delta writer.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => new Response(JSON.stringify(body), init),
  },
}), { virtual: true });

vi.mock("@/models", () => ({
  getProxyPoolById: vi.fn(),
  updateProxyPool: vi.fn(async (id, updates) => ({ id, ...updates })),
  mutateProxyPoolEntries: vi.fn(async (id, mutator) => {
    // Minimal pass-through: apply mutator to a snapshot so tests can assert
    // the mapping outcome.
    const pool = poolState;
    if (!pool || pool.isGroup !== true) return null;
    pool.entries = mutator(pool.entries);
    return pool;
  }),
}));
vi.mock("@/lib/network/proxyTest", () => ({
  testProxyUrl: vi.fn(),
}));
vi.mock("@/lib/xray/manager", () => ({
  runHealthCheck: vi.fn(async () => {}),
}));
vi.mock("undici", () => ({ fetch: vi.fn() }));

import { getProxyPoolById, updateProxyPool, mutateProxyPoolEntries } from "@/models";
import { testProxyUrl } from "@/lib/network/proxyTest";
import { runHealthCheck } from "@/lib/xray/manager";
import { POST } from "@/app/api/proxy-pools/[id]/test/route.js";

// Live pool state the mocks read/write — getProxyPoolById serves this object
// and updateProxyPool merges into it so consecutive tests model streaks.
let poolState;

function singlePool(overrides = {}) {
  return {
    id: "pool-1",
    name: "single",
    type: "http",
    isActive: true,
    strictProxy: false,
    proxyUrl: "http://proxy:8080",
    noProxy: "",
    failStreak: 0,
    ...overrides,
  };
}

function groupPool(entries) {
  return {
    id: "pool-1",
    name: "group",
    type: "http",
    isGroup: true,
    isActive: true,
    strictProxy: false,
    proxyUrl: "",
    entries,
    failStreak: 0,
  };
}

function entry(id) {
  return { id, name: id, type: "http", proxyUrl: `http://${id}:8080`, isActive: true, cooldownUntil: null, lastError: null, lastUsedAt: null };
}

async function callTest(id = "pool-1") {
  const res = await POST({}, { params: Promise.resolve({ id }) });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  vi.clearAllMocks();
  poolState = null;
  vi.mocked(getProxyPoolById).mockImplementation(async () => poolState);
  vi.mocked(updateProxyPool).mockImplementation(async (id, updates) => {
    poolState = { ...poolState, ...updates };
    return poolState;
  });
});

describe("single-pool streak deactivation (P1/N1)", () => {
  it("first failed test advances the streak but does NOT deactivate", async () => {
    poolState = singlePool();
    vi.mocked(testProxyUrl).mockResolvedValue({ ok: false, status: 502, error: "upstream broke" });
    const { body } = await callTest();
    expect(body.ok).toBe(false);
    expect(body.failStreak).toBe(1);
    expect(updateProxyPool).toHaveBeenCalledWith("pool-1", expect.objectContaining({ failStreak: 1, testStatus: "error" }));
    const updates = vi.mocked(updateProxyPool).mock.calls[0][1];
    expect(updates.isActive).toBeUndefined();
    expect(poolState.isActive).toBe(true);
  });

  it("third consecutive failure deactivates", async () => {
    poolState = singlePool({ failStreak: 2 });
    vi.mocked(testProxyUrl).mockResolvedValue({ ok: false, status: 502, error: "nope" });
    await callTest();
    expect(poolState.isActive).toBe(false);
    expect(poolState.failStreak).toBe(3);
    expect(poolState.lastError).toContain("deactivated after 3 consecutive failed tests");
  });

  it("a passing test resets the streak and re-activates", async () => {
    poolState = singlePool({ failStreak: 2, isActive: false });
    vi.mocked(testProxyUrl).mockResolvedValue({ ok: true, status: 200 });
    await callTest();
    expect(poolState.failStreak).toBe(0);
    expect(poolState.isActive).toBe(true);
    expect(poolState.testStatus).toBe("active");
  });

  it("managed v2go pool is never deactivated by a failed test", async () => {
    poolState = singlePool({ id: "v2go-xray-managed", failStreak: 5, _v2goManaged: true });
    vi.mocked(testProxyUrl).mockResolvedValue({ ok: false, status: 502, error: "node down" });
    await callTest("v2go-xray-managed");
    expect(poolState.isActive).toBe(true);
    expect(poolState.lastError).toContain("auto-rotation triggered");
    expect(runHealthCheck).toHaveBeenCalled();
  });
});

describe("group branch (N1/N2)", () => {
  it("'no entries to test' returns 400 and never deactivates", async () => {
    poolState = groupPool([]);
    const { status, body } = await callTest();
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(poolState.isActive).toBe(true);
    expect(updateProxyPool).toHaveBeenCalledWith("pool-1", expect.objectContaining({ lastError: expect.stringContaining("No proxy entries") }));
    const updates = vi.mocked(updateProxyPool).mock.calls[0][1];
    expect(updates.isActive).toBeUndefined();
    expect(updates.failStreak).toBeUndefined();
  });

  it("all entries failing once advances the streak without deactivation", async () => {
    poolState = groupPool([entry("e1"), entry("e2")]);
    vi.mocked(testProxyUrl).mockResolvedValue({ ok: false, status: 502, error: "dead" });
    const { body } = await callTest();
    expect(body.failStreak).toBe(1);
    expect(poolState.isActive).toBe(true);
    // Failed entries got their cooldown through the transactional delta writer.
    expect(mutateProxyPoolEntries).toHaveBeenCalled();
    expect(poolState.entries.find((e) => e.id === "e1").cooldownUntil).toBeGreaterThan(Date.now() - 1000);
  });

  it("third consecutive full-group failure deactivates the pool", async () => {
    poolState = groupPool([entry("e1")]);
    poolState.failStreak = 2;
    vi.mocked(testProxyUrl).mockResolvedValue({ ok: false, status: 502, error: "dead" });
    await callTest();
    expect(poolState.isActive).toBe(false);
  });

  it("at least one passing entry keeps the group active", async () => {
    poolState = groupPool([entry("e1"), entry("e2")]);
    vi.mocked(testProxyUrl).mockImplementation(async ({ proxyUrl }) => ({
      ok: proxyUrl.includes("e1"),
      status: proxyUrl.includes("e1") ? 200 : 502,
      error: proxyUrl.includes("e1") ? null : "dead",
    }));
    const { body } = await callTest();
    expect(body.ok).toBe(true);
    expect(body.group.passed).toBe(1);
    expect(poolState.isActive).toBe(true);
    expect(poolState.failStreak).toBe(0);
  });
});
