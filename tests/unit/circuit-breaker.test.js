// Phase 06 unit tests: circuitBreaker state machine — closed→open→half-open→
// closed, sliding window, exponential backoff with cap, exactly-one-probe
// admission under concurrency, kill-switch pass-through, noauth guard.
// NODE_ENV=test keeps the module on default config (no settings load).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkBreaker,
  recordFailure,
  recordSuccess,
  getBreakerStates,
  resetBreaker,
  __resetBreakersForTests,
} from "@/sse/services/circuitBreaker.js";

const T0 = 1_700_000_000_000; // fixed epoch — tests advance it explicitly

function advance(ms) {
  vi.setSystemTime(Date.now() + ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  __resetBreakersForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("state machine", () => {
  it("stays closed below the failure threshold", () => {
    for (let i = 0; i < 4; i++) {
      recordFailure("conn-1", "antigravity");
      advance(1_000);
    }
    expect(checkBreaker("conn-1")).toEqual({ allowed: true });
    const st = getBreakerStates().find((s) => s.connectionId === "conn-1");
    expect(st.state).toBe("closed");
    expect(st.failures).toBe(4);
  });

  it("opens at 5 failures within the 60s window and denies with retryAfterMs", () => {
    for (let i = 0; i < 5; i++) {
      recordFailure("conn-1", "antigravity");
      advance(1_000);
    }
    advance(2_000); // now t=7s; open happened at t=4s → openUntil t=64s
    const gate = checkBreaker("conn-1");
    expect(gate.allowed).toBe(false);
    expect(gate.retryAfterMs).toBe(57_000);
    const st = getBreakerStates().find((s) => s.connectionId === "conn-1");
    expect(st.state).toBe("open");
    expect(st.consecutiveOpens).toBe(1);
  });

  it("sliding window: failures older than 60s drop out of the count", () => {
    recordFailure("conn-1");
    advance(61_000); // first failure expired
    for (let i = 0; i < 4; i++) {
      recordFailure("conn-1");
      advance(1_000);
    }
    // 4 in-window failures + 1 expired → still closed
    expect(checkBreaker("conn-1")).toEqual({ allowed: true });
  });

  it("half-open admits exactly one probe after cooldown; success closes", () => {
    openConn("conn-1");
    advance(60_000); // cooldown elapsed
    const probe = checkBreaker("conn-1");
    expect(probe).toEqual({ allowed: true, probe: true });
    // concurrent request during probe is denied
    const second = checkBreaker("conn-1");
    expect(second.allowed).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(0);
    recordSuccess("conn-1");
    expect(checkBreaker("conn-1")).toEqual({ allowed: true });
    const st = getBreakerStates().find((s) => s.connectionId === "conn-1");
    expect(st.state).toBe("closed");
    expect(st.consecutiveOpens).toBe(0);
    expect(st.lastRecoveredAt).not.toBeNull();
  });

  it("backoff sequence 60/120/240/480/600/600 across repeated probe failures", () => {
    const expected = [60_000, 120_000, 240_000, 480_000, 600_000, 600_000];
    const remaining = [];
    for (let i = 0; i < expected.length; i++) {
      if (i === 0) {
        for (let f = 0; f < 5; f++) recordFailure("conn-1");
      } else {
        // previous open's cooldown elapsed → probe → fail again
        advanceToProbe();
        expect(checkBreaker("conn-1")).toEqual({ allowed: true, probe: true });
        recordFailure("conn-1");
      }
      const gate = checkBreaker("conn-1");
      expect(gate.allowed).toBe(false);
      remaining.push(gate.retryAfterMs);
      const st = getBreakerStates().find((s) => s.connectionId === "conn-1");
      expect(st.consecutiveOpens).toBe(i + 1);
      advance(1_000);
    }
    // allow ~1s drift from the advance(1_000) inside the measurement window
    remaining.forEach((ms, i) => {
      expect(Math.abs(ms - expected[i])).toBeLessThanOrEqual(2_000);
    });
  });

  it("recordSuccess mid-open (in-flight attempt) closes the breaker", () => {
    openConn("conn-1");
    recordSuccess("conn-1");
    expect(checkBreaker("conn-1")).toEqual({ allowed: true });
  });

  it("recordFailure while open records the timestamp but does not extend cooldown", () => {
    openConn("conn-1");
    const before = getBreakerStates()[0].remainingMs;
    advance(5_000);
    recordFailure("conn-1");
    const st = getBreakerStates()[0];
    expect(st.state).toBe("open");
    expect(st.consecutiveOpens).toBe(1);
    expect(st.remainingMs).toBe(before - 5_000);
  });
});

describe("guards", () => {
  it("noauth credentials (undefined connectionId) always pass", () => {
    expect(checkBreaker(undefined)).toEqual({ allowed: true });
    expect(() => recordFailure(undefined)).not.toThrow();
    expect(() => recordSuccess(undefined)).not.toThrow();
    expect(getBreakerStates()).toEqual([]);
  });

  it("success on an unknown account creates no state (healthy fast path)", () => {
    recordSuccess("never-failed");
    expect(getBreakerStates()).toEqual([]);
  });

  it("resetBreaker forgets the account", () => {
    openConn("conn-1");
    expect(resetBreaker("conn-1")).toBe(true);
    expect(checkBreaker("conn-1")).toEqual({ allowed: true });
    expect(getBreakerStates()).toEqual([]);
  });
});

describe("single probe under concurrency", () => {
  it("exactly one of 10 concurrent checkBreakers wins the probe", () => {
    openConn("conn-1");
    advance(60_000);
    const results = Array.from({ length: 10 }, () => checkBreaker("conn-1"));
    const probes = results.filter((r) => r.allowed && r.probe);
    const denied = results.filter((r) => !r.allowed);
    expect(probes).toHaveLength(1);
    expect(denied).toHaveLength(9);
  });

  it("a probe that never resolves keeps denying until cooldown math floors at 5s", () => {
    openConn("conn-1");
    advance(120_000); // cooldown long past, probe flag still set from a prior admission
    checkBreaker("conn-1"); // this consumed the probe
    const denied = checkBreaker("conn-1");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThanOrEqual(5_000);
  });
});

// helpers

function openConn(id) {
  for (let i = 0; i < 5; i++) {
    recordFailure(id, "antigravity");
    advance(1_000);
  }
  expect(checkBreaker(id).allowed).toBe(false);
}

function advanceToProbe() {
  // jump just past the current openUntil so the next checkBreaker half-opens
  const st = getBreakerStates()[0];
  const until = st.openUntil ? new Date(st.openUntil).getTime() : 0;
  vi.setSystemTime(until + 1);
}
