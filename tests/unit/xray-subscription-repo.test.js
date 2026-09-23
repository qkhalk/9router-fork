// Multi-subscription repo + legacy migration tests (Phase 1).
//
// Uses a REAL better-sqlite3 adapter on a temp DATA_DIR (harness copied from
// unit/needsrekey-boot-migration.test.js) so the SQL semantics under test —
// tombstone filters, the guarded retention sweeper, the membership backfill
// SELECT — are exercised against actual SQLite, not string-matched mocks.
// driver.getAdapter is redirected at the test adapter so repo functions run
// against the same file the migration wrote.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({ adapter: null }));

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => {
    if (!state.adapter) throw new Error("test adapter not ready");
    return state.adapter;
  }),
}));

let tempDir;
let originalDataDir;
let fileNo = 0;

beforeAll(() => {
  originalDataDir = process.env.DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-xray-subs-"));
  process.env.DATA_DIR = tempDir;
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows EPERM flake — temp dir */ }
});

const { createBetterSqliteAdapter } = await import("../../src/lib/db/adapters/betterSqliteAdapter.js");
const { runMigrationOnce } = await import("../../src/lib/db/migrate.js");
const xrayRepo = await import("../../src/lib/db/repos/xrayRepo.js");
const subRepo = await import("../../src/lib/db/repos/subscriptionRepo.js");

// Fresh DB file per scenario: markers and legacy rows must not leak across.
function makeFreshAdapter() {
  fileNo += 1;
  const file = path.join(tempDir, `db-${fileNo}.sqlite`);
  const adapter = createBetterSqliteAdapter(file);
  return runMigrationOnce(adapter).then(() => adapter);
}

function seedConfig(db, id, { link, isActive = 1, isSelected = 0, deletedAt = null, staleDeleteAfter = null } = {}) {
  db.run(
    `INSERT INTO xrayConfigs(id, link, name, protocol, isActive, isSelected, addedAt, updatedAt, deletedAt, staleDeleteAfter)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, link || `vless://share/${id}`, `cfg-${id}`, "vless", isActive, isSelected, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", deletedAt, staleDeleteAfter]
  );
}

function seedSettings(db, raw) {
  db.run(
    `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    [JSON.stringify({ xraySyncIntervalMin: 60, xrayStaleRetentionDays: 7, ...raw })]
  );
}

describe("schema auto-sync (fresh DB boot)", () => {
  it("creates the multi-sub tables and the tombstone columns", async () => {
    const db = await makeFreshAdapter();
    const tables = db.all(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => r.name);
    expect(tables).toContain("xraySubscriptions");
    expect(tables).toContain("xrayConfigSubscriptions");
    const cols = db.all(`PRAGMA table_info(xrayConfigs)`).map((c) => c.name);
    expect(cols).toContain("deletedAt");
    expect(cols).toContain("staleDeleteAfter");
  });
});

describe("subscriptionRepo CRUD", () => {
  it("creates, reads, updates and deletes a subscription", async () => {
    const db = await makeFreshAdapter();
    state.adapter = db;

    const created = await subRepo.createXraySubscription({ url: "https://airport.example.com/sub?token=abc", name: "Airport" });
    expect(created.id).toBeGreaterThan(0);
    expect(created.name).toBe("Airport");
    expect(created.enabled).toBe(true);
    // NULL interval/retention materialized from legacy global defaults
    expect(created.intervalMin).toBe(60);
    expect(created.retentionDays).toBe(7);

    expect((await subRepo.getXraySubscription(created.id)).url).toBe("https://airport.example.com/sub?token=abc");
    expect((await subRepo.getXraySubscriptionByUrl("https://airport.example.com/sub?token=abc")).id).toBe(created.id);
    expect(await subRepo.getXraySubscription(99999)).toBeNull();

    const updated = await subRepo.updateXraySubscription(created.id, { name: "Renamed", enabled: false, intervalMin: 0, retentionDays: -1 });
    expect(updated.name).toBe("Renamed");
    expect(updated.enabled).toBe(false);
    expect(updated.intervalMin).toBe(0);
    expect(updated.retentionDays).toBe(-1);

    // name defaults from URL host when empty/missing
    const noName = await subRepo.createXraySubscription({ url: "https://fallback.example.com/sub" });
    expect(noName.name).toBe("fallback.example.com");

    expect(await subRepo.deleteXraySubscription(created.id)).toBe(1);
    expect(await subRepo.getXraySubscription(created.id)).toBeNull();
  });

  it("rejects a duplicate URL with a typed URL_TAKEN error", async () => {
    const db = await makeFreshAdapter();
    state.adapter = db;
    await subRepo.createXraySubscription({ url: "https://dup.example.com/sub" });
    await expect(subRepo.createXraySubscription({ url: "https://dup.example.com/sub" })).rejects.toMatchObject({ code: "URL_TAKEN" });
    const only = (await subRepo.listXraySubscriptions()).find((s) => s.url === "https://dup.example.com/sub");
    const other = await subRepo.createXraySubscription({ url: "https://other.example.com/sub" });
    await expect(subRepo.updateXraySubscription(other.id, { url: "https://dup.example.com/sub" })).rejects.toMatchObject({ code: "URL_TAKEN" });
    expect(only).not.toBeNull();
  });

  it("validates URLs at the repo layer (RT-8)", async () => {
    const db = await makeFreshAdapter();
    state.adapter = db;
    for (const bad of [
      "ftp://example.com/sub",
      "javascript:alert(1)",
      "not a url",
      "",
      "https://user:pass@example.com/sub",
      `https://example.com/${"x".repeat(2100)}`,
    ]) {
      await expect(subRepo.createXraySubscription({ url: bad })).rejects.toMatchObject({ code: "INVALID_URL" });
    }
    expect(await subRepo.listXraySubscriptions()).toEqual([]);
  });
});

describe("membership lifecycle", () => {
  it("upserts, removes missing, detects zero-membership ids, and resets staleDeleteAfter on re-adoption (RT-2)", async () => {
    const db = await makeFreshAdapter();
    state.adapter = db;
    seedConfig(db, "a");
    seedConfig(db, "b");
    seedConfig(db, "c");
    const sub = await subRepo.createXraySubscription({ url: "https://s.example.com/1" });

    await xrayRepo.upsertMemberships(sub.id, ["a", "b"], "2026-01-01T00:00:00Z");
    // deactivate c with a past horizon: it has no membership, is inactive → sweepable
    await xrayRepo.deactivateXrayConfigs(["c"], "2026-01-02T00:00:00Z");
    expect(await xrayRepo.getConfigIdsWithNoMembership()).toEqual(["c"]);

    // sub drops b: b loses membership but stays active until Phase-2 flow deactivates it
    const lost = await xrayRepo.removeMissingMemberships(sub.id, ["a"]);
    expect(lost.sort()).toEqual(["b"]);
    expect(await xrayRepo.getConfigIdsWithNoMembership().then((r) => r.sort())).toEqual(["b", "c"]);

    // b re-adopted later — with a stale horizon already set, membership upsert clears it
    await xrayRepo.deactivateXrayConfigs(["b"], "2026-01-02T00:00:00Z");
    await xrayRepo.upsertMemberships(sub.id, ["a", "b"], "2026-01-04T00:00:00Z");
    const b = await xrayRepo.getXrayConfigById("b");
    expect(b.staleDeleteAfter).toBeNull();
    // sweep with a cutoff AFTER the original horizon: re-adopted b must survive (RT-2)
    expect(await xrayRepo.sweepStaleXrayConfigs("2026-01-10T00:00:00Z")).toBe(1); // only c
    expect(await xrayRepo.getXrayConfigById("b")).not.toBeNull();
    expect(await xrayRepo.getXrayConfigById("a")).not.toBeNull();
    expect(await xrayRepo.getXrayConfigById("c")).toBeNull();
  });
});

describe("tombstone / restore / hardDelete", () => {
  it("hides tombstoned rows from every read path and restores them (RT-10)", async () => {
    const db = await makeFreshAdapter();
    state.adapter = db;
    seedConfig(db, "keep");
    seedConfig(db, "gone", { isSelected: 1 });

    expect(await xrayRepo.deleteXrayConfig("gone")).toBe(true); // now a tombstone
    expect(await xrayRepo.getXrayConfigs()).toHaveLength(1);
    expect((await xrayRepo.getXrayConfigs())[0].id).toBe("keep");
    expect(await xrayRepo.getXrayConfigById("gone")).toBeNull();
    expect(await xrayRepo.getXrayConfigByLink("vless://share/gone")).toBeNull();
    expect((await xrayRepo.getXrayConfigCounts()).total).toBe(1);
    // selected row was tombstoned → fallback returns the healthiest ACTIVE config ("keep")
    expect((await xrayRepo.getSelectedXrayConfig())?.id).toBe("keep");
    // includeDeleted escape hatch for the deleted-servers UI
    expect((await xrayRepo.getXrayConfigs({ includeDeleted: true })).map((c) => c.id).sort()).toEqual(["gone", "keep"]);
    const tomb = (await xrayRepo.getXrayConfigs({ includeDeleted: true })).find((c) => c.id === "gone");
    expect(tomb.deletedAt).not.toBeNull();

    // restore clears BOTH deletedAt and staleDeleteAfter, reactivates
    await xrayRepo.deactivateXrayConfigs(["gone"], "2026-01-02T00:00:00Z").catch(() => {});
    expect(await xrayRepo.restoreXrayConfig("gone")).toBe(true);
    const restored = await xrayRepo.getXrayConfigById("gone");
    expect(restored.deletedAt).toBeNull();
    expect(restored.staleDeleteAfter).toBeNull();
    expect(restored.isActive).toBe(true);
    // double tombstone / restore of a visible row is a no-op
    expect(await xrayRepo.restoreXrayConfig("keep")).toBe(false);
  });

  it("hard-delete removes the row and its memberships; bulk upsert never clears deletedAt", async () => {
    const db = await makeFreshAdapter();
    state.adapter = db;
    seedConfig(db, "shared");
    const subA = await subRepo.createXraySubscription({ url: "https://a.example.com/1" });
    const subB = await subRepo.createXraySubscription({ url: "https://b.example.com/1" });
    await xrayRepo.upsertMemberships(subA.id, ["shared"]);
    await xrayRepo.upsertMemberships(subB.id, ["shared"]);

    expect(await xrayRepo.hardDeleteXrayConfig("shared")).toBe(true);
    expect(await xrayRepo.getXrayConfigById("shared")).toBeNull();
    expect(db.all(`SELECT * FROM xrayConfigSubscriptions WHERE configId = 'shared'`)).toEqual([]);

    // tombstoned row reappearing in a fetch: bulk upsert keeps it deleted (never resurrects),
    // only clearing the retention horizon
    seedConfig(db, "zombie");
    await xrayRepo.tombstoneXrayConfig("zombie");
    await xrayRepo.bulkUpsertXrayConfigs([{ id: "zombie", link: "vless://share/zombie" }]);
    const zombie = (await xrayRepo.getXrayConfigs({ includeDeleted: true })).find((c) => c.id === "zombie");
    expect(zombie.deletedAt).not.toBeNull();
    expect(zombie.staleDeleteAfter).toBeNull();

    // clearXrayConfigs wipes memberships too
    await xrayRepo.upsertMemberships(subA.id, ["zombie"]);
    await xrayRepo.clearXrayConfigs();
    expect(db.all(`SELECT * FROM xrayConfigSubscriptions`)).toEqual([]);
  });

  it("sweeper only eats inactive, non-tombstoned, membership-free rows past the horizon", async () => {
    const db = await makeFreshAdapter();
    state.adapter = db;
    seedConfig(db, "due", { staleDeleteAfter: "2000-01-01T00:00:00Z", isActive: 0 }); // due → swept
    seedConfig(db, "future", { staleDeleteAfter: "2999-01-01T00:00:00Z", isActive: 0 }); // not due
    seedConfig(db, "active", { staleDeleteAfter: "2000-01-01T00:00:00Z" });              // still active
    seedConfig(db, "tomb", { deletedAt: "2000-01-01T00:00:00Z", staleDeleteAfter: "2000-01-01T00:00:00Z", isActive: 0 }); // tombstoned
    seedConfig(db, "membered", { staleDeleteAfter: "2000-01-01T00:00:00Z", isActive: 0 }); // re-gained a membership
    const sub = await subRepo.createXraySubscription({ url: "https://s.example.com/2" });
    // direct INSERT (bypassing upsertMemberships' horizon reset) so the
    // sweeper's NOT EXISTS guard itself is what saves the row
    db.run(`INSERT INTO xrayConfigSubscriptions(configId, subscriptionId, lastSeenAt) VALUES('membered', ?, ?)`, [sub.id, "2026-01-01T00:00:00Z"]);

    expect(await xrayRepo.sweepStaleXrayConfigs("2026-06-01T00:00:00Z")).toBe(1);
    const survivors = (await xrayRepo.getXrayConfigs({ includeDeleted: true })).map((c) => c.id).sort();
    expect(survivors).toEqual(["active", "future", "membered", "tomb"]);
    expect(await xrayRepo.hardDeleteXrayConfig("tomb")).toBe(true); // explicit hard-delete still works on tombstones
  });
});

describe("legacy one-shot migration (migrateLegacySubscription)", () => {
  // makeFreshAdapter runs the full boot path (runMigrationOnce), which now
  // fires the legacy migration itself — on a fresh DB that run finds no
  // legacy URL (settings not yet seeded) and just stamps the marker. Clear
  // the marker so each scenario below starts from "never migrated".
  async function makeLegacyAdapter() {
    const db = await makeFreshAdapter();
    db.run(`DELETE FROM _meta WHERE key LIKE 'xray-subs-migration%'`);
    state.adapter = db;
    return db;
  }

  it("creates the Default sub + memberships once; deleting all subs never resurrects it (RT-6)", async () => {
    const db = await makeLegacyAdapter();
    seedConfig(db, "c1");
    seedConfig(db, "c2", { isSelected: 1 });
    seedConfig(db, "c3", { isActive: 0 });
    seedSettings(db, { xraySubscriptionUrl: "https://legacy.example.com/sub" });

    const r1 = subRepo.migrateLegacySubscription(db);
    expect(r1.migrated).toBe(true);
    expect(r1.configs).toBe(3);
    const subs = await subRepo.listXraySubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0].name).toBe("Default");
    expect(subs[0].url).toBe("https://legacy.example.com/sub");
    expect(subs[0].intervalMin).toBe(60);
    expect(subs[0].retentionDays).toBe(7);
    expect(db.all(`SELECT configId FROM xrayConfigSubscriptions WHERE subscriptionId = ${subs[0].id}`).length).toBe(3);
    // catalog + selection untouched
    expect((await xrayRepo.getXrayConfigById("c2")).isSelected).toBe(true);
    expect((await xrayRepo.getXrayConfigById("c3")).isActive).toBe(false);

    // second call: marker short-circuits even though subs exist
    expect(subRepo.migrateLegacySubscription(db).migrated).toBe(false);

    // delete-all-subs + re-run → NO resurrection (marker, not emptiness)
    for (const s of await subRepo.listXraySubscriptions()) await subRepo.deleteXraySubscription(s.id);
    const r2 = subRepo.migrateLegacySubscription(db);
    expect(r2.migrated).toBe(false); // marker short-circuits: nothing re-imported
    expect(await subRepo.listXraySubscriptions()).toEqual([]);
  });

  it("skips sub creation for empty or invalid legacy URLs but still sets the marker", async () => {
    const dbEmpty = await makeLegacyAdapter();
    seedSettings(dbEmpty, { xraySubscriptionUrl: "" });
    const rEmpty = subRepo.migrateLegacySubscription(dbEmpty);
    expect(rEmpty.migrated).toBe(true);
    expect(await subRepo.listXraySubscriptions()).toEqual([]);
    expect(subRepo.migrateLegacySubscription(dbEmpty).migrated).toBe(false); // marker set

    const dbInvalid = await makeLegacyAdapter();
    seedConfig(dbInvalid, "c1");
    seedSettings(dbInvalid, { xraySubscriptionUrl: "ftp://bad.example.com/sub" });
    const rInvalid = subRepo.migrateLegacySubscription(dbInvalid);
    expect(rInvalid.migrated).toBe(true);
    expect(rInvalid.subId).toBeNull();
    expect(await subRepo.listXraySubscriptions()).toEqual([]);
    expect(subRepo.migrateLegacySubscription(dbInvalid).migrated).toBe(false);
    // membership count == config count check does not apply: no sub created
  });

  it("migrated legacy URL passes the same validation gate as API-created subs", async () => {
    // valid legacy URL round-trips through create/update validation
    const db = await makeLegacyAdapter();
    seedSettings(db, { xraySubscriptionUrl: "https://user:pass@evil.example.com/sub" }); // credentials → rejected
    const r = subRepo.migrateLegacySubscription(db);
    expect(r.subId).toBeNull();
    expect(await subRepo.listXraySubscriptions()).toEqual([]);
  });
});
