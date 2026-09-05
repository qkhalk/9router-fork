// Phase 07 unit tests: the v2go/xray health scheduler — interval honored,
// 0 = manual-only, single-flight overlap skip, tick errors never reject,
// rotation-failure → xray-rotation-failed alert (the ONLY event it emits;
// xray-node-down is owned by manager.js), state introspection.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const manager = vi.hoisted(() => ({ runHealthCheck: vi.fn(async () => ({ skipped: true })) }));
const alerts = vi.hoisted(() => ({ emitAlert: vi.fn() }));

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });
vi.mock("@/lib/xray/manager.js", () => ({ runHealthCheck: manager.runHealthCheck }));
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

import {
  runXrayHealthCheckTick,
  configureXrayHealthCheck,
  getXrayHealthSchedulerState,
  __resetXrayHealthSchedulerForTests,
} from "@/lib/xray/healthScheduler.js";

beforeEach(() => {
  vi.useFakeTimers();
  __resetXrayHealthSchedulerForTests();
  manager.runHealthCheck.mockReset();
  manager.runHealthCheck.mockResolvedValue({ skipped: true });
  alerts.emitAlert.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => { });
  vi.spyOn(console, "warn").mockImplementation(() => { });
});

afterEach(() => {
  __resetXrayHealthSchedulerForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("configureXrayHealthCheck", () => {
  it("arms the timer for the configured interval and fires the tick", async () => {
    configureXrayHealthCheck({ xrayHealthCheckIntervalMin: 5 });
    const st = getXrayHealthSchedulerState();
    expect(st.armed).toBe(true);
    expect(st.intervalMs).toBe(5 * 60_000);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(manager.runHealthCheck).toHaveBeenCalledTimes(1);
  });

  it("clamps positives to >= 5 min", () => {
    configureXrayHealthCheck({ xrayHealthCheckIntervalMin: 1 });
    expect(getXrayHealthSchedulerState().intervalMs).toBe(5 * 60_000);
  });

  it("defaults to 10 min when the key is absent", () => {
    configureXrayHealthCheck({});
    expect(getXrayHealthSchedulerState().intervalMs).toBe(10 * 60_000);
  });

  it("0 / negative / NaN = manual-only: timer cleared, no tick ever", async () => {
    for (const bad of [0, -5, NaN, "abc"]) {
      configureXrayHealthCheck({ xrayHealthCheckIntervalMin: bad });
      expect(getXrayHealthSchedulerState().armed).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(manager.runHealthCheck).not.toHaveBeenCalled();
  });

  it("re-configure replaces the timer (PATCH re-arm semantics)", async () => {
    configureXrayHealthCheck({ xrayHealthCheckIntervalMin: 5 });
    configureXrayHealthCheck({ xrayHealthCheckIntervalMin: 30 });
    expect(getXrayHealthSchedulerState().intervalMs).toBe(30 * 60_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000); // old interval must NOT fire
    expect(manager.runHealthCheck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25 * 60_000);
    expect(manager.runHealthCheck).toHaveBeenCalledTimes(1);
  });

  it("PATCH to 0 mid-run stops future ticks", async () => {
    configureXrayHealthCheck({ xrayHealthCheckIntervalMin: 5 });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(manager.runHealthCheck).toHaveBeenCalledTimes(1);
    configureXrayHealthCheck({ xrayHealthCheckIntervalMin: 0 });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(manager.runHealthCheck).toHaveBeenCalledTimes(1); // no more
  });
});

describe("tick behavior", () => {
  it("skipped result (no managed xray) records state and emits nothing", async () => {
    manager.runHealthCheck.mockResolvedValue({ skipped: true });
    const res = await runXrayHealthCheckTick();
    expect(res).toEqual({ skipped: true });
    expect(alerts.emitAlert).not.toHaveBeenCalled();
    expect(getXrayHealthSchedulerState().lastResult).toBe("skipped");
  });

  it("healthy result → no alert, lastResult ok", async () => {
    manager.runHealthCheck.mockResolvedValue({ latencyMs: 120, activeConfigId: "cfg-1", rotatedTo: null, rotationFailed: false });
    await runXrayHealthCheckTick();
    expect(alerts.emitAlert).not.toHaveBeenCalled();
    expect(getXrayHealthSchedulerState().lastResult).toBe("ok");
  });

  it("rotation failure → xray-rotation-failed alert (the ONLY event this scheduler emits)", async () => {
    manager.runHealthCheck.mockResolvedValue({
      latencyMs: 0, activeConfigId: "cfg-1", rotatedTo: null,
      rotationFailed: true,
      rotationError: "auto-rotation failed for all 2 candidate(s); keeping current active node",
    });
    await runXrayHealthCheckTick();
    expect(alerts.emitAlert).toHaveBeenCalledTimes(1);
    const [eventType, payload] = alerts.emitAlert.mock.calls[0];
    expect(eventType).toBe("xray-rotation-failed");
    expect(payload.severity).toBe("critical");
    expect(payload.dedupKey).toBe("xray-rotation");
    expect(payload.body).toContain("auto-rotation failed");
    expect(getXrayHealthSchedulerState().lastResult).toBe("rotation-failed");
  });

  it("successful rotation → rotated:id recorded, no rotation alert", async () => {
    manager.runHealthCheck.mockResolvedValue({ latencyMs: 0, activeConfigId: "cfg-1", rotatedTo: "cfg-2", rotationFailed: false });
    await runXrayHealthCheckTick();
    expect(alerts.emitAlert).not.toHaveBeenCalled();
    expect(getXrayHealthSchedulerState().lastResult).toBe("rotated:cfg-2");
  });

  it("down node without rotation attempt → lastResult down, no alert here", async () => {
    // xray-node-down comes from manager.js (phase-05), never from this scheduler.
    manager.runHealthCheck.mockResolvedValue({ latencyMs: 0, activeConfigId: "cfg-1", rotatedTo: null, rotationFailed: false });
    await runXrayHealthCheckTick();
    expect(alerts.emitAlert).not.toHaveBeenCalled();
    expect(getXrayHealthSchedulerState().lastResult).toBe("down");
  });

  it("single-flight: an in-flight check skips the next interval fire", async () => {
    let release;
    manager.runHealthCheck.mockImplementation(() => new Promise((r) => { release = r; }));
    configureXrayHealthCheck({ xrayHealthCheckIntervalMin: 5 });

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(manager.runHealthCheck).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000); // still in flight
    expect(manager.runHealthCheck).toHaveBeenCalledTimes(1);

    release({ latencyMs: 50, activeConfigId: "cfg-1", rotatedTo: null, rotationFailed: false });
    await vi.advanceTimersByTimeAsync(5 * 60_000); // now free
    expect(manager.runHealthCheck).toHaveBeenCalledTimes(2);
  });

  it("a throwing runHealthCheck never rejects the interval callback", async () => {
    manager.runHealthCheck.mockRejectedValue(new Error("probe crashed"));
    await expect(runXrayHealthCheckTick()).resolves.toMatchObject({ error: "probe crashed" });
    expect(getXrayHealthSchedulerState().lastResult).toBe("error:probe crashed");
    expect(getXrayHealthSchedulerState().running).toBe(false);
  });

  it("state exposes running/armed/intervalMs/lastRunAt/lastResult", async () => {
    manager.runHealthCheck.mockResolvedValue({ latencyMs: 10, activeConfigId: "c", rotatedTo: null, rotationFailed: false });
    await runXrayHealthCheckTick();
    const st = getXrayHealthSchedulerState();
    expect(st).toMatchObject({ armed: false, running: false, lastResult: "ok" });
    expect(st.lastRunAt).toBeTruthy();
  });
});
