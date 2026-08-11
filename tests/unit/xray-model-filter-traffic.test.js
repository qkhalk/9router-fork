import { describe, it, expect, vi, afterEach } from "vitest";
import {
  beginLiveModelTraffic,
  getActiveLiveTrafficCount,
  waitForLiveTrafficQuiet,
} from "../../src/lib/xray/modelFilterTraffic.js";

describe("xray model filter live traffic tracker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits while live traffic is active and resumes after the quiet window", async () => {
    vi.useFakeTimers();
    const finish = beginLiveModelTraffic();
    let settled = false;

    const wait = waitForLiveTrafficQuiet({ quietMs: 10, maxWaitMs: 5000 }).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);
    expect(getActiveLiveTrafficCount()).toBe(1);

    finish();
    await vi.advanceTimersByTimeAsync(1000);

    await expect(wait).resolves.toMatchObject({ timedOut: false });
    expect(settled).toBe(true);
    expect(getActiveLiveTrafficCount()).toBe(0);
  });

  it("stops waiting when the caller disables pause-on-traffic", async () => {
    vi.useFakeTimers();
    const finish = beginLiveModelTraffic();
    let pauseEnabled = true;

    const wait = waitForLiveTrafficQuiet({
      quietMs: 15000,
      maxWaitMs: 5000,
      shouldContinue: () => pauseEnabled,
    });

    await vi.advanceTimersByTimeAsync(1000);
    pauseEnabled = false;
    await vi.advanceTimersByTimeAsync(1000);

    await expect(wait).resolves.toMatchObject({ timedOut: false, cancelled: true });
    finish();
    expect(getActiveLiveTrafficCount()).toBe(0);
  });
});
