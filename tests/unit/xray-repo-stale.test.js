import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [],
  run: vi.fn((sql, params) => {
    if (sql.includes("UPDATE xrayConfigs SET isActive = 0")) {
      const ids = new Set(params.slice(1));
      for (const row of mocks.rows) {
        if (ids.has(row.id)) row.isActive = 0;
      }
      return { changes: ids.size };
    }
    if (sql.includes("DELETE FROM xrayConfigs WHERE isActive = 0")) {
      const before = mocks.rows.length;
      mocks.rows = mocks.rows.filter((row) => row.isActive !== 0);
      return { changes: before - mocks.rows.length };
    }
  }),
}));

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => ({
    all: vi.fn(() => mocks.rows.map((row) => ({ id: row.id }))),
    run: mocks.run,
  })),
}));

const { markStaleXrayConfigs, cleanupStaleXrayConfigs } = await import("../../src/lib/db/repos/xrayRepo.js");

describe("markStaleXrayConfigs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows = [];
  });

  it("does not mark kept configs stale when the subscription exceeds one chunk", async () => {
    const keepIds = Array.from({ length: 745 }, (_, i) => `cfg-${i}`);
    mocks.rows = keepIds.map((id) => ({ id, isActive: 1 }));

    await markStaleXrayConfigs(keepIds);

    expect(mocks.rows.every((row) => row.isActive === 1)).toBe(true);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("marks only ids missing from the latest subscription as stale", async () => {
    const keepIds = Array.from({ length: 745 }, (_, i) => `cfg-${i}`);
    mocks.rows = [...keepIds, "old-a", "old-b"].map((id) => ({ id, isActive: 1 }));

    await markStaleXrayConfigs(keepIds);

    expect(mocks.rows.filter((row) => row.isActive === 0).map((row) => row.id)).toEqual(["old-a", "old-b"]);
    expect(mocks.rows.filter((row) => keepIds.includes(row.id)).every((row) => row.isActive === 1)).toBe(true);
  });

  it("can immediately delete inactive configs when retention is zero", async () => {
    mocks.rows = [
      { id: "active-a", isActive: 1 },
      { id: "old-a", isActive: 0 },
      { id: "old-b", isActive: 0 },
    ];

    await expect(cleanupStaleXrayConfigs(0)).resolves.toBe(2);

    expect(mocks.rows.map((row) => row.id)).toEqual(["active-a"]);
  });
});
