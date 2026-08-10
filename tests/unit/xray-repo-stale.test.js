import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [],
  run: vi.fn((sql, params) => {
    if (!sql.includes("UPDATE xrayConfigs SET isActive = 0")) return;
    const ids = new Set(params.slice(1));
    for (const row of mocks.rows) {
      if (ids.has(row.id)) row.isActive = 0;
    }
  }),
}));

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => ({
    all: vi.fn(() => mocks.rows.map((row) => ({ id: row.id }))),
    run: mocks.run,
  })),
}));

const { markStaleXrayConfigs } = await import("../../src/lib/db/repos/xrayRepo.js");

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
});
