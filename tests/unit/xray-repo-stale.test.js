// The global stale path (markStaleXrayConfigs/cleanupStaleXrayConfigs) was
// replaced by membership-aware deactivation + a guarded retention sweeper in
// the multi-subscription plan. This file now pins the chunk-safety and
// retention semantics of the replacement primitives (the underlying SQL is
// exercised against a REAL adapter in xray-subscription-repo.test.js; mocks
// here keep the unit boundary cheap).
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  run: vi.fn(() => ({ changes: 0 })),
}));

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => ({
    all: vi.fn(() => []),
    run: mocks.run,
  })),
}));

const xrayRepo = await import("../../src/lib/db/repos/xrayRepo.js");
const subRepo = await import("../../src/lib/db/repos/subscriptionRepo.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("membership-aware deactivation chunking (>999 ids)", () => {
  it("chunks the UPDATE so catalogs beyond the SQLite parameter limit still deactivate fully", async () => {
    const ids = Array.from({ length: 1249 }, (_, i) => `cfg-${i}`);
    await xrayRepo.deactivateXrayConfigs(ids, "2026-09-30T00:00:00.000Z");
    // CHUNK = 500 → 500 + 500 + 249
    expect(mocks.run).toHaveBeenCalledTimes(3);
    const sizes = mocks.run.mock.calls.map(([, params]) => params.length - 2);
    expect(sizes).toEqual([500, 500, 249]);
    for (const call of mocks.run.mock.calls) {
      expect(call[0]).toContain("deletedAt IS NULL");
      expect(call[0]).toContain("staleDeleteAfter = ?");
    }
  });

  it("retention -1 keeps rows forever (NULL horizon), 0 deletes as soon as swept", () => {
    expect(subRepo.resolveRetentionDays({ retentionDays: -1 }, 7)).toBe(-1);
    expect(subRepo.resolveRetentionDays({ retentionDays: 0 }, 7)).toBe(0);
    expect(subRepo.resolveRetentionDays({ retentionDays: null }, 7)).toBe(7);
  });
});

describe("sweeper guard surface", () => {
  it("only sweeps inactive, non-tombstoned, membership-free rows past the horizon", async () => {
    await xrayRepo.sweepStaleXrayConfigs("2026-09-23T00:00:00.000Z");
    expect(mocks.run).toHaveBeenCalledTimes(1);
    const [sql, params] = mocks.run.mock.calls[0];
    expect(sql).toContain("staleDeleteAfter IS NOT NULL");
    expect(sql).toContain("staleDeleteAfter <= ?");
    expect(sql).toContain("isActive = 0");
    expect(sql).toContain("deletedAt IS NULL");
    expect(sql).toContain("NOT EXISTS");
    expect(params).toEqual(["2026-09-23T00:00:00.000Z"]);
  });

  it("refuses to run without a cutoff timestamp", async () => {
    await expect(xrayRepo.sweepStaleXrayConfigs(null)).resolves.toBe(0);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
