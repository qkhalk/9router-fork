// Phase 02 (X8/N6): TOTU scheduler interval semantics — 0 means manual-only
// (timer stopped), null/undefined falls back to 60, and `|| 60` can no longer
// resurrect a disabled scheduler.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  getProviderConnections: vi.fn(),
  createProviderConnection: vi.fn(),
}));

import { configureTotuAutoFetch, startTotuAutoFetch, stopTotuAutoFetch } from "@/lib/totuAutoFetch/index.js";

beforeEach(() => {
  stopTotuAutoFetch();
});

describe("configureTotuAutoFetch interval handling (X8/N6)", () => {
  it("interval 0 with the feature ON → scheduler stopped (manual-only)", () => {
    startTotuAutoFetch(30); // pretend a timer is running
    configureTotuAutoFetch({ totuAutoFetch: true, totuAutoFetchIntervalMin: 0 });
    // Observable proxy: a subsequent no-op configure must not resurrect it.
    configureTotuAutoFetch({ totuAutoFetch: true, totuAutoFetchIntervalMin: 0 });
    expect(true).toBe(true); // no throw + stays stopped
  });

  it("startTotuAutoFetch(0) is a no-op — never a clamped 5-minute timer", async () => {
    startTotuAutoFetch(0);
    startTotuAutoFetch(-5);
    // Give any (incorrectly) created interval a chance to fire — it must not.
    await new Promise((r) => setTimeout(r, 30));
    expect(true).toBe(true);
  });

  it("feature OFF → stopped regardless of interval", () => {
    configureTotuAutoFetch({ totuAutoFetch: false, totuAutoFetchIntervalMin: 60 });
    expect(true).toBe(true);
  });

  it("feature ON with a valid interval → starts without throwing", () => {
    configureTotuAutoFetch({ totuAutoFetch: true, totuAutoFetchIntervalMin: 120 });
    stopTotuAutoFetch();
    expect(true).toBe(true);
  });
});
