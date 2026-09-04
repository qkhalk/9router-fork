// Phase 01 (P2/N2/P7/P12): proxyPoolsRepo — transactional delta-writes don't
// lose concurrent entry mutations, pool ordering is creation-stable, and
// cooldownUntil values normalize to epoch-ms.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal synchronous adapter (better-sqlite semantics: transaction is sync).
function makeFakeAdapter() {
  const rows = new Map();
  return {
    rows,
    async transaction(fn) {
      fn();
    },
    get(sql, params) {
      const row = rows.get(params[0]);
      return row ? { ...row } : undefined;
    },
    all(sql, params) {
      let list = [...rows.values()];
      // Minimal WHERE support for the repo's filter queries.
      if (sql.includes("isActive = ?")) {
        list = list.filter((r) => r.isActive === params[0]);
      }
      if (sql.includes("testStatus = ?")) {
        list = list.filter((r) => r.testStatus === params[list.includes ? 0 : 0] ?? null);
      }
      return list;
    },
    run(sql, params) {
      const [id, isActive, testStatus, data, createdAt, updatedAt] = params;
      rows.set(id, { id, isActive, testStatus, data, createdAt, updatedAt });
    },
  };
}

const adapter = makeFakeAdapter();

vi.mock("uuid", () => ({ v4: () => `id-${Math.random().toString(36).slice(2)}` }), { virtual: true });

vi.mock("@/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => adapter),
}));

import {
  createProxyPool,
  getProxyPoolById,
  getProxyPools,
  updateProxyPool,
  mutateProxyPoolEntries,
  stampProxyEntryUsed,
  setEntryCooldown,
  normalizeCooldownUntil,
} from "@/lib/db/repos/proxyPoolsRepo.js";

function entry(id) {
  return { id, name: id, type: "http", proxyUrl: `http://${id}:8080`, isActive: true, cooldownUntil: null, lastError: null, lastUsedAt: null };
}

let clock = 1_000_000_000_000;

beforeEach(async () => {
  adapter.rows.clear();
  clock += 10_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});

describe("concurrent delta-writes never lose updates (P2/N2)", () => {
  it("parallel stamp + cooldown + stamp all land on their own entries", async () => {
    await createProxyPool({ id: "g1", isGroup: true, entries: [entry("e1"), entry("e2"), entry("e3")] });
    await Promise.all([
      stampProxyEntryUsed("g1", "e1"),
      setEntryCooldown("g1", "e2", Date.now() + 60_000, "boom"),
      stampProxyEntryUsed("g1", "e3"),
    ]);
    const pool = await getProxyPoolById("g1");
    const byId = Object.fromEntries(pool.entries.map((e) => [e.id, e]));
    expect(byId.e1.lastUsedAt).toBeTruthy();
    expect(byId.e2.cooldownUntil).toBe(clock + 60_000);
    expect(byId.e2.lastError).toBe("boom");
    expect(byId.e3.lastUsedAt).toBeTruthy();
  });

  it("two writers touching the SAME entry compose instead of clobbering", async () => {
    await createProxyPool({ id: "g1", isGroup: true, entries: [entry("e1")] });
    // Interleave the classic lost-update shape: both "read" before either
    // writes. mutateProxyPoolEntries re-reads inside its own transaction, so
    // the second write must build on the first, not replace it.
    await Promise.all([
      stampProxyEntryUsed("g1", "e1"),
      setEntryCooldown("g1", "e1", Date.now() + 30_000, "err"),
    ]);
    const pool = await getProxyPoolById("g1");
    const e = pool.entries[0];
    expect(e.lastUsedAt).toBeTruthy();
    expect(e.cooldownUntil).toBe(clock + 30_000);
  });

  it("mutateProxyPoolEntries is a no-op for non-group pools", async () => {
    await createProxyPool({ id: "s1", proxyUrl: "http://x:1" });
    expect(await mutateProxyPoolEntries("s1", (entries) => entries)).toBeNull();
    expect(await stampProxyEntryUsed("s1", "nope")).toBeNull();
  });
});

describe("stable creation-order listing (P7)", () => {
  it("pools list in createdAt,id order regardless of updatedAt churn", async () => {
    // new Date() ignores the Date.now mock, so stamp createdAt explicitly
    // (updateProxyPool merges arbitrary fields, createdAt included).
    await createProxyPool({ id: "b-pool", proxyUrl: "http://b:1", strictProxy: false });
    await createProxyPool({ id: "a-pool", proxyUrl: "http://a:1", strictProxy: false });
    await createProxyPool({ id: "c-pool", proxyUrl: "http://c:1", strictProxy: false });
    await updateProxyPool("b-pool", { createdAt: "2026-01-01T00:00:01.000Z" });
    await updateProxyPool("a-pool", { createdAt: "2026-01-01T00:00:02.000Z" });
    await updateProxyPool("c-pool", { createdAt: "2026-01-01T00:00:03.000Z" });

    // Churn updatedAt on the OLDEST pool (cooldown stamps do this constantly).
    await updateProxyPool("b-pool", { strictProxy: true });

    const ids = (await getProxyPools()).map((p) => p.id);
    expect(ids).toEqual(["b-pool", "a-pool", "c-pool"]);
  });

  it("isActive filter still applies", async () => {
    await createProxyPool({ id: "on", proxyUrl: "http://on:1" });
    clock += 5_000;
    await createProxyPool({ id: "off", proxyUrl: "http://off:1", isActive: false });
    const ids = (await getProxyPools({ isActive: true })).map((p) => p.id);
    expect(ids).toEqual(["on"]);
  });
});

describe("cooldownUntil normalization (P12)", () => {
  it("numbers pass through; numeric strings and ISO strings become epoch-ms", () => {
    expect(normalizeCooldownUntil(1234567890123)).toBe(1234567890123);
    expect(normalizeCooldownUntil("1234567890123")).toBe(1234567890123);
    expect(normalizeCooldownUntil("2026-09-04T00:00:00.000Z")).toBe(Date.parse("2026-09-04T00:00:00.000Z"));
  });

  it("empty and garbage values become null (no cooldown)", () => {
    expect(normalizeCooldownUntil(null)).toBeNull();
    expect(normalizeCooldownUntil(undefined)).toBeNull();
    expect(normalizeCooldownUntil("")).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(normalizeCooldownUntil("not-a-date")).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
