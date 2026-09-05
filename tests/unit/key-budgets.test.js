// Phase 08 unit tests: keyBudgets — window math (local midnight / month /
// year rollover), edge-triggered threshold alert (once per window, re-arms on
// rollover), enforcement (soft alert, hard block 429 + Retry-After + header,
// unbudgeted keys query nothing, spend-read failure fails open).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const usageRepo = vi.hoisted(() => ({ getSpendForKey: vi.fn(async () => ({ usd: 0, tokens: 0 })) }));
const alerts = vi.hoisted(() => ({ emitAlert: vi.fn() }));

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });
vi.mock("@/lib/db/repos/usageRepo.js", () => ({ getSpendForKey: usageRepo.getSpendForKey }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({
  // keyBudgets only uses the mask for display/fingerprinting.
  maskApiKey: (k) => `sk-…${String(k).slice(-4)}`,
}));
vi.mock("@/lib/alerts", () => ({
  emitAlert: alerts.emitAlert,
  EVENT_TYPES: { BUDGET_THRESHOLD: "budget-threshold" },
  SEVERITY: { INFO: "info", WARN: "warn", CRITICAL: "critical" },
}));

import {
  startOfWindow,
  windowEndDate,
  windowKey,
  checkKeyBudget,
  __resetKeyBudgetsForTests,
} from "@/sse/services/keyBudgets.js";

const RAW = "sk-machine-keyid01-abcd";

function budgetRow(overrides = {}) {
  return {
    budgetType: "usd",
    budgetLimit: 10,
    budgetWindow: "daily",
    softThresholdPct: 80,
    hardBlock: 0,
    name: "team-key",
    ...overrides,
  };
}

beforeEach(() => {
  usageRepo.getSpendForKey.mockReset();
  usageRepo.getSpendForKey.mockResolvedValue({ usd: 0, tokens: 0 });
  alerts.emitAlert.mockReset();
  __resetKeyBudgetsForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("window math (server-local)", () => {
  it("daily window starts at local midnight and ends at the next one", () => {
    const now = new Date(2026, 8, 5, 14, 30, 5); // Sep 5 2026 14:30:05 local
    const start = startOfWindow("daily", now);
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(8);
    expect(start.getDate()).toBe(5);
    expect(start.getHours()).toBe(0);
    const end = windowEndDate("daily", now);
    expect(end.getDate()).toBe(6);
    expect(end.getHours()).toBe(0);
  });

  it("monthly window: 1st of month → 1st of next month, incl. December rollover", () => {
    const now = new Date(2026, 11, 18, 9, 0, 0); // Dec 18 2026
    expect(startOfWindow("monthly", now).getMonth()).toBe(11);
    expect(startOfWindow("monthly", now).getDate()).toBe(1);
    const end = windowEndDate("monthly", now);
    expect(end.getFullYear()).toBe(2027);
    expect(end.getMonth()).toBe(0);
    expect(end.getDate()).toBe(1);
  });

  it("windowKey is stable within the window and changes across boundaries", () => {
    expect(windowKey("daily", new Date(2026, 8, 5, 0, 0, 0))).toBe("2026-09-05");
    expect(windowKey("daily", new Date(2026, 8, 5, 23, 59, 59))).toBe("2026-09-05");
    expect(windowKey("daily", new Date(2026, 8, 6, 0, 0, 0))).toBe("2026-09-06");
    expect(windowKey("monthly", new Date(2026, 8, 5))).toBe("2026-09");
    expect(windowKey("monthly", new Date(2026, 9, 1))).toBe("2026-10");
  });
});

describe("checkKeyBudget", () => {
  it("unbudgeted keys short-circuit before any spend query (hot-path guard)", async () => {
    expect(await checkKeyBudget(RAW, budgetRow({ budgetType: "off" }))).toBeNull();
    expect(await checkKeyBudget(RAW, budgetRow({ budgetLimit: 0 }))).toBeNull();
    expect(await checkKeyBudget(RAW, null)).toBeNull();
    expect(await checkKeyBudget("", budgetRow())).toBeNull();
    expect(usageRepo.getSpendForKey).not.toHaveBeenCalled();
  });

  it("under threshold: allowed, no alert", async () => {
    usageRepo.getSpendForKey.mockResolvedValue({ usd: 3, tokens: 0 }); // 30%
    expect(await checkKeyBudget(RAW, budgetRow())).toBeNull();
    expect(alerts.emitAlert).not.toHaveBeenCalled();
    expect(usageRepo.getSpendForKey).toHaveBeenCalledWith(RAW, expect.any(Date));
  });

  it("soft threshold crossing alerts ONCE per window (edge-triggered)", async () => {
    usageRepo.getSpendForKey.mockResolvedValue({ usd: 8.5, tokens: 0 }); // 85%
    await checkKeyBudget(RAW, budgetRow());
    await checkKeyBudget(RAW, budgetRow()); // second request same window
    expect(alerts.emitAlert).toHaveBeenCalledTimes(1);
    const [eventType, payload] = alerts.emitAlert.mock.calls[0];
    expect(eventType).toBe("budget-threshold");
    expect(payload.severity).toBe("warn");
    expect(payload.body).toContain("85%");
    expect(payload.body).toContain("team-key");
    expect(payload.body).not.toContain(RAW); // fingerprint only, never the key
  });

  it("soft alert re-arms when the window rolls over", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 5, 12, 0, 0));
    usageRepo.getSpendForKey.mockResolvedValue({ usd: 9, tokens: 0 });
    await checkKeyBudget(RAW, budgetRow());
    expect(alerts.emitAlert).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(2026, 8, 6, 0, 0, 5)); // next day, same key
    await checkKeyBudget(RAW, budgetRow());
    expect(alerts.emitAlert).toHaveBeenCalledTimes(2); // re-armed
  });

  it("hard block at limit: 429 with Retry-After (window end) + X-9Router-Budget header", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 5, 23, 0, 0)); // 1h left in the day
    usageRepo.getSpendForKey.mockResolvedValue({ usd: 10, tokens: 0 });
    const res = await checkKeyBudget(RAW, budgetRow({ hardBlock: 1 }));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(3595);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    expect(res.headers.get("X-9Router-Budget")).toBe("limit-exceeded");
    const body = await res.json();
    expect(body.error.code).toBe("api_key_budget_exceeded");
  });

  it("hard block NOT reached (just under limit): allowed even at 99%", async () => {
    usageRepo.getSpendForKey.mockResolvedValue({ usd: 9.9, tokens: 0 });
    expect(await checkKeyBudget(RAW, budgetRow({ hardBlock: 1 }))).toBeNull();
  });

  it("token budgets use the token sum, not USD", async () => {
    usageRepo.getSpendForKey.mockResolvedValue({ usd: 999, tokens: 500_000 });
    const res = await checkKeyBudget(RAW, budgetRow({ budgetType: "tokens", budgetLimit: 500_000, hardBlock: 1 }));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(429);
    expect(alerts.emitAlert).toHaveBeenCalledTimes(1);
    expect(alerts.emitAlert.mock.calls[0][1].body).toContain("500,000 tokens");
  });

  it("spend-read failure fails open (never breaks the request path)", async () => {
    usageRepo.getSpendForKey.mockRejectedValue(new Error("db locked"));
    expect(await checkKeyBudget(RAW, budgetRow({ hardBlock: 1 }))).toBeNull();
    expect(alerts.emitAlert).not.toHaveBeenCalled();
  });

  it("custom threshold respected (e.g. 50%)", async () => {
    usageRepo.getSpendForKey.mockResolvedValue({ usd: 5.5, tokens: 0 }); // 55%
    await checkKeyBudget(RAW, budgetRow({ softThresholdPct: 50 }));
    expect(alerts.emitAlert).toHaveBeenCalledTimes(1);
  });
});
