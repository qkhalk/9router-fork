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
});
