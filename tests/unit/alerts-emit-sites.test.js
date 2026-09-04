import { beforeEach, describe, expect, it, vi } from "vitest";

// Emit-site wiring (phase 05 step 4): the hot-path producers actually call
// emitAlert with the right event types. The alerts module itself is inert
// under NODE_ENV=test, so mocking it here has zero side effects.

const alerts = vi.hoisted(() => ({ emitAlert: vi.fn() }));

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });
vi.mock("@/lib/alerts", () => ({
  emitAlert: alerts.emitAlert,
  EVENT_TYPES: {
    ALL_ACCOUNTS_LOCKED: "all-accounts-locked",
    BREAKER_OPEN: "breaker-open",
    BREAKER_RECOVERED: "breaker-recovered",
    PROXY_POOL_EXHAUSTED: "proxy-pool-exhausted",
    STRICTPROXY_VIOLATION: "strictproxy-violation",
    QUOTA_NEAR_LIMIT: "quota-near-limit",
    BUDGET_THRESHOLD: "budget-threshold",
    XRAY_NODE_DOWN: "xray-node-down",
    XRAY_ROTATION_FAILED: "xray-rotation-failed",
    TOTU_FETCH_FAILED: "totu-fetch-failed",
  },
  SEVERITY: { INFO: "info", WARN: "warn", CRITICAL: "critical" },
}));

vi.mock("@/models", () => ({
  getProxyPoolById: vi.fn(),
  stampProxyEntryUsed: vi.fn(async () => null),
  getProxyPools: vi.fn(async () => []),
  updateProxyPool: vi.fn(async () => null),
}));

import { getProxyPoolById } from "@/models";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("proxy-pool-exhausted emit site (connectionProxy)", () => {
  it("fires on an exhausted strict pool with the pool as dedupKey", async () => {
    vi.mocked(getProxyPoolById).mockResolvedValue({
      id: "pool-9",
      name: "strict group",
      isGroup: true,
      isActive: false, // inactive strict pool → exhausted
      strictProxy: true,
      proxyUrl: "",
      noProxy: "",
      entries: [],
    });

    const res = await resolveConnectionProxyConfig({ proxyPoolId: "pool-9" });

    expect(res.source).toBe("exhausted");
    expect(alerts.emitAlert).toHaveBeenCalledTimes(1);
    const [eventType, payload] = alerts.emitAlert.mock.calls[0];
    expect(eventType).toBe("proxy-pool-exhausted");
    expect(payload.dedupKey).toBe("pool-9");
    expect(payload.severity).toBe("warn");
  });

  it("does NOT fire for a healthy pool resolution", async () => {
    vi.mocked(getProxyPoolById).mockResolvedValue({
      id: "pool-ok",
      name: "ok",
      isGroup: false,
      isActive: true,
      strictProxy: false,
      proxyUrl: "http://ok:8080",
      noProxy: "",
      entries: [],
    });

    const res = await resolveConnectionProxyConfig({ proxyPoolId: "pool-ok" });
    expect(res.connectionProxyUrl).toBe("http://ok:8080");
    expect(alerts.emitAlert).not.toHaveBeenCalled();
  });
});
