/**
 * Data-access layer for cached Model Proxy Filter probe results.
 *
 * One row per (configId, model): the most recent probe outcome. The
 * xrayConfigs.id is a sha1 of the canonical share link (see syncParse.js),
 * so it doubles as a stable fingerprint — a config whose link changes is a
 * new id and therefore a fresh cache entry. The cache lifetime is the
 * subscription sync cycle: orphaned rows (config no longer active) are pruned
 * after each sync, and any row can be cleared manually via the UI.
 *
 * Follows the rowToX/XToRow + upsert + transaction pattern of the other repos
 * (see xrayRepo.js). Conforms to the db adapter API so it works across all
 * SQLite backends.
 */

import { getAdapter } from "../driver.js";

// ─── mapper ───────────────────────────────────────────────────────────────

function rowToResult(row) {
  if (!row) return null;
  return {
    configId: row.configId,
    model: row.model,
    ok: row.ok === 1 || row.ok === true,
    latencyMs: row.latencyMs,
    status: row.status,
    exitIp: row.exitIp,
    error: row.error,
    testedAt: row.testedAt,
  };
}

// ─── reads ────────────────────────────────────────────────────────────────

/** Get the cached result for a single (configId, model), or null. */
export async function getModelFilterResult(configId, model) {
  const db = await getAdapter();
  return rowToResult(db.get(
    `SELECT * FROM xrayModelFilterResults WHERE configId = ? AND model = ?`,
    [configId, model]
  ));
}

/**
 * Bulk-fetch cached results for a list of config ids under one model.
 * Returns a Map<configId, result>. Chunked defensively for big catalogs
 * (SQLite's parameter limit is generous, but IN (?,?,...) with thousands of
 * ids can still bite).
 */
export async function getModelFilterResultsByConfigIds(configIds = [], model) {
  const out = new Map();
  if (!configIds.length || !model) return out;
  const db = await getAdapter();
  const CHUNK = 500;
  for (let i = 0; i < configIds.length; i += CHUNK) {
    const slice = configIds.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    const rows = db.all(
      `SELECT * FROM xrayModelFilterResults WHERE model = ? AND configId IN (${placeholders})`,
      [model, ...slice]
    );
    for (const row of rows) out.set(row.configId, rowToResult(row));
  }
  return out;
}

/** Aggregate counts for the UI status badge. */
export async function getModelFilterCacheStats() {
  const db = await getAdapter();
  const totalRow = db.get(`SELECT COUNT(*) AS n FROM xrayModelFilterResults`);
  const byModelRows = db.all(
    `SELECT model, COUNT(*) AS n FROM xrayModelFilterResults GROUP BY model`
  );
  const byModel = {};
  for (const r of byModelRows) byModel[r.model] = Number(r.n) || 0;
  return { total: Number(totalRow?.n) || 0, byModel };
}

// ─── writes ───────────────────────────────────────────────────────────────

/** Upsert the latest probe result for one (configId, model). */
export async function upsertModelFilterResult(data = {}) {
  const db = await getAdapter();
  const now = data.testedAt || new Date().toISOString();
  db.run(
    `INSERT INTO xrayModelFilterResults(configId, model, ok, latencyMs, status, exitIp, error, testedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(configId, model) DO UPDATE SET
       ok = excluded.ok,
       latencyMs = excluded.latencyMs,
       status = excluded.status,
       exitIp = excluded.exitIp,
       error = excluded.error,
       testedAt = excluded.testedAt`,
    [
      data.configId,
      data.model,
      data.ok ? 1 : 0,
      data.latencyMs ?? null,
      data.status ?? null,
      data.exitIp ?? null,
      data.error ?? null,
      now,
    ]
  );
  return getModelFilterResult(data.configId, data.model);
}

/** Clear every cached result for one model (used by force re-test). */
export async function clearModelFilterResultsByModel(model) {
  if (!model) return 0;
  const db = await getAdapter();
  const res = db.run(`DELETE FROM xrayModelFilterResults WHERE model = ?`, [model]);
  return res?.changes || 0;
}

/** Wipe the entire cache (used by the "Clear cache" button). */
export async function clearAllModelFilterResults() {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM xrayModelFilterResults`);
  return res?.changes || 0;
}

/** Drop cached rows for the given config ids (used when configs are pruned). */
export async function deleteModelFilterResultsByConfigIds(configIds = []) {
  if (!configIds.length) return 0;
  const db = await getAdapter();
  let removed = 0;
  const CHUNK = 500;
  db.transaction(() => {
    for (let i = 0; i < configIds.length; i += CHUNK) {
      const slice = configIds.slice(i, i + CHUNK);
      const placeholders = slice.map(() => "?").join(",");
      const res = db.run(
        `DELETE FROM xrayModelFilterResults WHERE configId IN (${placeholders})`,
        slice
      );
      removed += res?.changes || 0;
    }
  });
  return removed;
}

/**
 * Drop cached rows whose config is no longer active in the catalog.
 * Called after each subscription sync so the cache tracks reality.
 */
export async function pruneOrphanModelFilterResults() {
  const db = await getAdapter();
  const res = db.run(
    `DELETE FROM xrayModelFilterResults
     WHERE configId NOT IN (SELECT id FROM xrayConfigs WHERE isActive = 1)`
  );
  return res?.changes || 0;
}
