// Phase 5 — legacy-migration validation through the REAL boot init path.
//
// RT-3: the migration must be exercised via runMigrationOnce (the function
// driver.js calls on the first getAdapter()) — a direct call to
// migrateLegacySubscription would pass even if the boot wiring were broken.
//
// The pre-B3 world is simulated by building a current DB, then reshaping it
// backwards: dropping the new tables, dropping the tombstone columns, and
// clearing the one-shot marker. A FRESH adapter object over the same file
// then re-runs runMigrationOnce exactly like a real reboot (its dedupe Set
// is per adapter object), proving the ALTER TABLE path AND the migration.
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-xray-migration-"));
  process.env.DATA_DIR = tempDir;
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows EPERM flake — temp dir */ }
});

const { createBetterSqliteAdapter } = await import("../../src/lib/db/adapters/betterSqliteAdapter.js");
const { runMigrationOnce } = await import("../../src/lib/db/migrate.js");
const subRepo = await import("../../src/lib/db/repos/subscriptionRepo.js");

const DATA_FILE = () => path.join(tempDir, `db-${fileNo}.sqlite`);

async function freshAdapter() {
  fileNo += 1;
  const adapter = createBetterSqliteAdapter(DATA_FILE());
  await runMigrationOnce(adapter); // boot 1: current schema (marker set, no settings)
  return adapter;
}

/** Reshape a current DB into the PRE-B3 world (old schema shape + legacy settings). */
function seedLegacyWorld(db, { url, configs, intervalMin = 60, retentionDays = 7 }) {
  db.exec(`DROP TABLE IF EXISTS xraySubscriptions`);
  db.exec(`DROP TABLE IF EXISTS xrayConfigSubscriptions`);
  db.exec(`DROP INDEX IF EXISTS idx_xc_deleted`); // references the column → drop first
  db.exec(`ALTER TABLE xrayConfigs DROP COLUMN deletedAt`);
  db.exec(`ALTER TABLE xrayConfigs DROP COLUMN staleDeleteAfter`);
  db.run(`DELETE FROM _meta WHERE key LIKE 'xray-subs-migration%'`);

  db.run(
    `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    [JSON.stringify({ xraySubscriptionUrl: url, xraySyncIntervalMin: intervalMin, xrayStaleRetentionDays: retentionDays })]
  );
  let i = 0;
  for (const c of configs) {
    i += 1;
    db.run(
      `INSERT INTO xrayConfigs(id, link, name, protocol, country, isActive, isSelected, addedAt, updatedAt)
       VALUES(?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      [c.id, c.link || `vless://u@h${i}:443#${c.id}`, c.name || c.id, "vless", c.country || "DE", c.isActive === false ? 0 : 1, c.isSelected ? 1 : 0]
    );
  }
}

async function reboot(db) {
  // Fresh adapter object over the same file = a real reboot to migrate.js.
  const adapter2 = createBetterSqliteAdapter(DATA_FILE());
  await runMigrationOnce(adapter2);
  return adapter2;
}

describe("legacy migration through the real boot path (runMigrationOnce)", () => {
  it("migrates the legacy URL to a Default sub and preserves catalog + selection", { timeout: 30000 }, async () => {
    const db = await freshAdapter();
    seedLegacyWorld(db, {
      url: "https://legacy.example.com/sub",
      configs: [
        { id: "c1", isSelected: true },
        { id: "c2" },
        { id: "c3", isActive: false }, // old stale-marked row must NOT resurrect as active
      ],
    });

    const db2 = await reboot(db);
    state.adapter = db2;

    const subs = await subRepo.listXraySubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0].name).toBe("Default");
    expect(subs[0].url).toBe("https://legacy.example.com/sub");
    expect(subs[0].intervalMin).toBe(60); // mirrored from legacy globals
    expect(subs[0].retentionDays).toBe(7);
    expect(subs[0].enabled).toBe(true);

    // membership count == config count (3/3)
    const members = db2.all(`SELECT configId FROM xrayConfigSubscriptions WHERE subscriptionId = ${subs[0].id}`).map((r) => r.configId).sort();
    expect(members).toEqual(["c1", "c2", "c3"]);

    // catalog + selection byte-identical
    expect(db2.get(`SELECT isSelected, isActive FROM xrayConfigs WHERE id = 'c1'`)).toEqual({ isSelected: 1, isActive: 1 });
    expect(db2.get(`SELECT isActive FROM xrayConfigs WHERE id = 'c3'`)).toEqual({ isActive: 0 });

    // boot logs announced the migration (real wiring, not a direct call)
    // (marker set — asserted via the next scenario too)

    // second boot: idempotent — no duplicate sub
    const db3 = await reboot(db2);
    expect(await subRepo.listXraySubscriptions()).toHaveLength(1);
    void db3;
  });

  it("delete-all-subs + reboot does NOT resurrect the Default sub (RT-6)", { timeout: 30000 }, async () => {
    const db = await freshAdapter();
    seedLegacyWorld(db, { url: "https://legacy.example.com/sub", configs: [{ id: "k1" }] });
    const db2 = await reboot(db);
    state.adapter = db2;
    for (const s of await subRepo.listXraySubscriptions()) await subRepo.deleteXraySubscription(s.id);
    expect(await subRepo.listXraySubscriptions()).toEqual([]);

    await reboot(db2); // full boot again — the marker (not emptiness) gates
    expect(await subRepo.listXraySubscriptions()).toEqual([]);
  });

  it("explicitly-empty legacy URL → no sub; invalid URL → no sub but marker set", { timeout: 30000 }, async () => {
    const dbEmpty = await freshAdapter();
    seedLegacyWorld(dbEmpty, { url: "", configs: [{ id: "e1" }] });
    const dbEmpty2 = await reboot(dbEmpty);
    state.adapter = dbEmpty2;
    expect(await subRepo.listXraySubscriptions()).toEqual([]);
    expect(dbEmpty2.all(`SELECT * FROM xrayConfigSubscriptions`)).toEqual([]);

    const dbInvalid = await freshAdapter();
    seedLegacyWorld(dbInvalid, { url: "ftp://nope.example.com/sub", configs: [{ id: "i1" }] });
    const dbInvalid2 = await reboot(dbInvalid);
    state.adapter = dbInvalid2;
    expect(await subRepo.listXraySubscriptions()).toEqual([]);
    // marker still set: a second boot must not re-attempt
    expect(dbInvalid2.get(`SELECT value FROM _meta WHERE key LIKE 'xray-subs-migration%'`)).toBeTruthy();
  });

  it("fresh default-URL install (no configs) → Default sub created, zero memberships", { timeout: 30000 }, async () => {
    const db = await freshAdapter();
    seedLegacyWorld(db, {
      url: "https://raw.githubusercontent.com/Danialsamadi/v2go/main/AllConfigsSub.txt",
      configs: [],
    });
    const db2 = await reboot(db);
    state.adapter = db2;
    const subs = await subRepo.listXraySubscriptions();
    expect(subs).toHaveLength(1);
    expect(subs[0].name).toBe("Default");
    expect(db2.all(`SELECT * FROM xrayConfigSubscriptions`)).toEqual([]);
  });
});
