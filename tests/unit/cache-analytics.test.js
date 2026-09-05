// Phase 09 unit tests: getCacheAnalytics — grouping from byModel, hit-rate
// math (zero-denominator → null), no-token-data rows excluded, pricing gap →
// savedUsd null (n/a, never 0), priced savings math, summary blending.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });

const pricing = vi.hoisted(() => ({ table: {} }));
vi.mock("../../src/lib/db/repos/pricingRepo.js", () => ({
  // input = USD per 1M prompt tokens
  getPricingForModel: vi.fn(async (provider, model) => pricing.table[`${provider}|${model}`] ?? null),
}));

// The repo module pulls the DB driver; only getCacheAnalytics is under test.
vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: vi.fn(async () => { throw new Error("no db in this test"); }) }));

import { getCacheAnalytics } from "../../src/lib/db/repos/usageRepo.js";

function statsWith(models) {
  const byModel = {};
  for (const [key, m] of Object.entries(models)) {
    byModel[key] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: m.rawModel, provider: m.provider, rawProvider: m.rawProvider ?? m.provider, lastUsed: "2026-09-05", ...m };
  }
  return { byModel };
}

beforeEach(() => {
  pricing.table = {};
  vi.clearAllMocks();
});

describe("getCacheAnalytics (phase 09)", () => {
  it("groups per (provider, model), computes hit rate and priced savings", async () => {
    pricing.table = {
      "anthropic|claude-sonnet-4.6": { input: 3.0, output: 15.0 },
    };
    const cache = await getCacheAnalytics(statsWith({
      "claude-sonnet-4.6 (anthropic)": {
        rawModel: "claude-sonnet-4.6", provider: "Anthropic", rawProvider: "anthropic",
        requests: 10, promptTokens: 1_000_000, cachedTokens: 500_000,
      },
    }));
    const row = cache.rows[0];
    expect(row.model).toBe("claude-sonnet-4.6");
    expect(row.hitRatePct).toBe(50);
    expect(row.savedUsd).toBeCloseTo(1.5, 6); // 0.5M × $3/M
    expect(cache.summary.blendedHitRatePct).toBe(50);
    expect(cache.summary.savedUsd).toBeCloseTo(1.5, 4);
    expect(cache.summary.pricedRows).toBe(1);
    expect(cache.summary.unpricedRows).toBe(0);
  });

  it("missing pricing → savedUsd null (n/a), never 0; summary still sums priced rows", async () => {
    pricing.table = { "anthropic|claude-sonnet-4.6": { input: 3.0 } };
    const cache = await getCacheAnalytics(statsWith({
      "claude-sonnet-4.6 (anthropic)": { rawModel: "claude-sonnet-4.6", rawProvider: "anthropic", provider: "A", requests: 5, promptTokens: 100_000, cachedTokens: 100_000 },
      "mystery (unknown-provider)": { rawModel: "mystery", rawProvider: "unknown-provider", provider: "U", requests: 5, promptTokens: 100_000, cachedTokens: 100_000 },
    }));
    const claude = cache.rows.find((r) => r.model === "claude-sonnet-4.6");
    const mystery = cache.rows.find((r) => r.model === "mystery");
    expect(claude.savedUsd).toBeCloseTo(0.3, 6);
    expect(mystery.savedUsd).toBeNull();
    expect(cache.summary.savedUsd).toBeCloseTo(0.3, 4);
    expect(cache.summary.pricedRows).toBe(1);
    expect(cache.summary.unpricedRows).toBe(1);
  });

  it("zero promptTokens (all-cached row) → hitRate null, not 0%", async () => {
    const cache = await getCacheAnalytics(statsWith({
      "x (p)": { rawModel: "x", rawProvider: "p", provider: "P", requests: 1, promptTokens: 0, cachedTokens: 42 },
    }));
    expect(cache.rows[0].hitRatePct).toBeNull();
    expect(cache.summary.blendedHitRatePct).toBeNull();
  });

  it("rows without ANY token signal are excluded (unknown, not misses)", async () => {
    const cache = await getCacheAnalytics(statsWith({
      "silent (p)": { rawModel: "silent", rawProvider: "p", provider: "P", requests: 99, promptTokens: 0, cachedTokens: 0 },
      "loud (p)": { rawModel: "loud", rawProvider: "p", provider: "P", requests: 1, promptTokens: 100, cachedTokens: 0 },
    }));
    expect(cache.rows.map((r) => r.model)).toEqual(["loud"]);
    expect(cache.rows[0].hitRatePct).toBe(0); // real 0% — has tokens, no cache
  });

  it("rows sort by cachedTokens descending; empty stats → empty block with null summary ratios", async () => {
    const empty = await getCacheAnalytics({ byModel: {} });
    expect(empty.rows).toEqual([]);
    expect(empty.summary.totalCachedTokens).toBe(0);
    expect(empty.summary.blendedHitRatePct).toBeNull();
    expect(empty.summary.savedUsd).toBeNull();

    const cache = await getCacheAnalytics(statsWith({
      "small (p)": { rawModel: "small", rawProvider: "p", provider: "P", promptTokens: 10, cachedTokens: 5 },
      "big (p)": { rawModel: "big", rawProvider: "p", provider: "P", promptTokens: 10, cachedTokens: 5000 },
    }));
    expect(cache.rows.map((r) => r.model)).toEqual(["big", "small"]);
  });

  it("pricingRepo import failure degrades to all-n/a without throwing", async () => {
    const { getPricingForModel } = await import("../../src/lib/db/repos/pricingRepo.js");
    getPricingForModel.mockRejectedValue(new Error("boom"));
    const cache = await getCacheAnalytics(statsWith({
      "x (p)": { rawModel: "x", rawProvider: "p", provider: "P", promptTokens: 100, cachedTokens: 100 },
    }));
    expect(cache.rows[0].savedUsd).toBeNull();
    expect(cache.summary.savedUsd).toBeNull();
  });
});
