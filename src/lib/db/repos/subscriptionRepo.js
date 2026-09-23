/**
 * Data-access layer for xray subscriptions (multi-subscription model).
 *
 * A subscription is one fetch source with its own url, enable flag, interval,
 * retention, and last-sync/traffic state (v2rayN per-sub convention). Configs
 * attach to subs via xrayConfigSubscriptions membership rows (see xrayRepo).
 *
 * URL validation lives HERE (repo layer, not route layer) so every write path
 * — API CRUD, the legacy boot migration — passes the same gate.
 *
 * Mirrors the rowToX / XToRow + adapter API (get/all/run/transaction) pattern
 * used by the other repos so it works across all four SQLite backends.
 */

import { getAdapter } from "../driver.js";
import { parseJson } from "../helpers/jsonCol.js";

// Typed errors so routes can map to status codes without string matching.
export class SubscriptionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SubscriptionError";
    this.code = code; // INVALID_URL | URL_TAKEN | NOT_FOUND
  }
}

// ─── URL validation (RT-8: single source of truth) ────────────────────────

const MAX_URL_LENGTH = 2048;

/** http/https only, length ≤ 2048, no credentials component. */
export function validateSubscriptionUrl(url) {
  if (typeof url !== "string" || !url.trim()) {
    throw new SubscriptionError("INVALID_URL", "subscription url is required");
  }
  const trimmed = url.trim();
  if (trimmed.length > MAX_URL_LENGTH) {
    throw new SubscriptionError("INVALID_URL", `subscription url exceeds ${MAX_URL_LENGTH} chars`);
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SubscriptionError("INVALID_URL", "subscription url is not a valid absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SubscriptionError("INVALID_URL", "subscription url must use http or https");
  }
  if (parsed.username || parsed.password) {
    throw new SubscriptionError("INVALID_URL", "subscription url must not contain credentials");
  }
  return trimmed;
}

// ─── mapping ──────────────────────────────────────────────────────────────

function rowToSubscription(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    enabled: row.enabled === 1 || row.enabled === true,
    intervalMin: row.intervalMin ?? null,
    retentionDays: row.retentionDays ?? null,
    lastSyncAt: row.lastSyncAt,
    lastSyncCount: row.lastSyncCount,
    lastSyncError: row.lastSyncError,
    uploadBytes: Number(row.uploadBytes) || 0,
    downloadBytes: Number(row.downloadBytes) || 0,
    totalBytes: Number(row.totalBytes) || 0,
    expireAt: row.expireAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── CRUD ─────────────────────────────────────────────────────────────────

export async function listXraySubscriptions(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.enabled !== undefined) {
    where.push("enabled = ?");
    params.push(filter.enabled ? 1 : 0);
  }
  const sql = `SELECT * FROM xraySubscriptions${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id ASC`;
  return db.all(sql, params).map(rowToSubscription);
}

export async function getXraySubscription(id) {
  const db = await getAdapter();
  return rowToSubscription(db.get(`SELECT * FROM xraySubscriptions WHERE id = ?`, [id]));
}

export async function getXraySubscriptionByUrl(url) {
  const db = await getAdapter();
  return rowToSubscription(db.get(`SELECT * FROM xraySubscriptions WHERE url = ?`, [url]));
}

/**
 * Create a subscription. NULL intervalMin/retentionDays mean "inherit the
 * legacy global defaults at resolve time", but inserts materialize the
 * CURRENT legacy-global value so the settings keys keep acting as "defaults
 * for new subscriptions" exactly per contract.
 */
export async function createXraySubscription({ name, url, enabled, intervalMin, retentionDays }) {
  const validUrl = validateSubscriptionUrl(url);
  const db = await getAdapter();
  const now = new Date().toISOString();
  const existing = db.get(`SELECT id FROM xraySubscriptions WHERE url = ?`, [validUrl]);
  if (existing) {
    throw new SubscriptionError("URL_TAKEN", `a subscription with this url already exists (id ${existing.id})`);
  }
  // Materialize legacy defaults for NULL interval/retention.
  let effInterval = intervalMin ?? null;
  let effRetention = retentionDays ?? null;
  if (effInterval == null || effRetention == null) {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const raw = row ? parseJson(row.data, {}) : {};
    if (effInterval == null) effInterval = raw.xraySyncIntervalMin ?? 60;
    if (effRetention == null) effRetention = raw.xrayStaleRetentionDays ?? 7;
  }
  const finalName = (typeof name === "string" && name.trim()) || new URL(validUrl).host;
  const res = db.run(
    `INSERT INTO xraySubscriptions(name, url, enabled, intervalMin, retentionDays, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [
      finalName,
      validUrl,
      enabled === false ? 0 : 1,
      effInterval,
      effRetention,
      now, now,
    ]
  );
  return getXraySubscription(res?.lastInsertRowid ?? db.get(`SELECT id FROM xraySubscriptions WHERE url = ?`, [validUrl])?.id);
}

export async function updateXraySubscription(id, patch = {}) {
  const db = await getAdapter();
  const current = await getXraySubscription(id);
  if (!current) throw new SubscriptionError("NOT_FOUND", `subscription ${id} not found`);
  const next = {
    name: patch.name !== undefined ? (typeof patch.name === "string" && patch.name.trim() ? patch.name.trim() : current.name) : current.name,
    url: patch.url !== undefined ? validateSubscriptionUrl(patch.url) : current.url,
    enabled: patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : (current.enabled ? 1 : 0),
    intervalMin: patch.intervalMin !== undefined ? patch.intervalMin : current.intervalMin,
    retentionDays: patch.retentionDays !== undefined ? patch.retentionDays : current.retentionDays,
  };
  if (next.url !== current.url) {
    const clash = db.get(`SELECT id FROM xraySubscriptions WHERE url = ? AND id != ?`, [next.url, id]);
    if (clash) throw new SubscriptionError("URL_TAKEN", `a subscription with this url already exists (id ${clash.id})`);
  }
  db.run(
    `UPDATE xraySubscriptions SET name = ?, url = ?, enabled = ?, intervalMin = ?, retentionDays = ?, updatedAt = ? WHERE id = ?`,
    [next.name, next.url, next.enabled, next.intervalMin, next.retentionDays, new Date().toISOString(), id]
  );
  return getXraySubscription(id);
}

export async function deleteXraySubscription(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM xraySubscriptions WHERE id = ?`, [id]);
  const changes = res?.changes || 0;
  if (changes > 0) {
    // Memberships die with the sub; configs orphaned by this are handled by
    // the caller (sync engine / route applies the sub's retention policy).
    db.run(`DELETE FROM xrayConfigSubscriptions WHERE subscriptionId = ?`, [id]);
  }
  return changes;
}

// ─── sync-state + userinfo writers ────────────────────────────────────────

/** Stamp lastSyncAt=now plus the given count/error on the sub row. */
export async function setXraySubscriptionSyncState(id, { lastSyncCount, lastSyncError } = {}) {
  const db = await getAdapter();
  db.run(
    `UPDATE xraySubscriptions SET lastSyncAt = ?, lastSyncCount = ?, lastSyncError = ?, updatedAt = ? WHERE id = ?`,
    [new Date().toISOString(), lastSyncCount ?? null, lastSyncError ?? null, new Date().toISOString(), id]
  );
  return getXraySubscription(id);
}

/** Persist subscription-userinfo traffic/expiry (bytes; expireAt ISO or null). */
export async function setXraySubscriptionUserinfo(id, { uploadBytes, downloadBytes, totalBytes, expireAt } = {}) {
  const db = await getAdapter();
  db.run(
    `UPDATE xraySubscriptions SET uploadBytes = ?, downloadBytes = ?, totalBytes = ?, expireAt = ?, updatedAt = ? WHERE id = ?`,
    [
      Number(uploadBytes) || 0,
      Number(downloadBytes) || 0,
      Number(totalBytes) || 0,
      expireAt ?? null,
      new Date().toISOString(),
      id,
    ]
  );
  return getXraySubscription(id);
}

// ─── effective resolvers ──────────────────────────────────────────────────

// Floor keeps users from hammering an upstream; ceiling (14 days) keeps
// setTimeout delays under Node's 2^31-1 ms clamp (an unclamped 30-day custom
// interval would fire in ~1ms — a sync storm).
export const MIN_SUB_INTERVAL_MIN = 5;
export const MAX_SUB_INTERVAL_MIN = 20160; // 14 days

/**
 * Effective interval for a sub in minutes. 0 = manual-only (honored as-is);
 * strictly positive values clamp to [5, 20160]. Falls back to the legacy
 * global default when the sub row stores NULL.
 */
export function resolveIntervalMin(sub, legacyDefault = 60) {
  let min = sub?.intervalMin;
  if (min == null || min === "" || Number.isNaN(Number(min))) {
    min = legacyDefault;
  }
  min = Number(min);
  if (!Number.isFinite(min) || min <= 0) return 0; // manual-only
  return Math.min(MAX_SUB_INTERVAL_MIN, Math.max(MIN_SUB_INTERVAL_MIN, Math.floor(min)));
}

/**
 * Effective retention (days) for a sub: -1 = keep forever, 0 = delete as soon
 * as lost, N = keep N days after loss. Falls back to the legacy global
 * default when the sub row stores NULL.
 */
export function resolveRetentionDays(sub, legacyDefault = 7) {
  const days = sub?.retentionDays;
  if (days == null || days === "" || Number.isNaN(Number(days))) {
    return Number(legacyDefault) || 0;
  }
  return Number(days);
}

// ─── legacy one-shot migration ────────────────────────────────────────────

// One-shot marker (NOT an emptiness check): emptiness cannot distinguish
// "never migrated" from "user deleted all subs" — a bare check would
// resurrect the Default sub on every boot after the user deletes it.
const LEGACY_SUBS_MARKER = "xray-subs-migration-v1";

/**
 * Migrate the single legacy `settings.xraySubscriptionUrl` into a "Default"
 * subscription + membership backfill. Runs at most once EVER (marker in
 * _meta). Takes the adapter as a parameter because it is invoked from
 * runMigrationOnce during boot, where getAdapter() would deadlock on the
 * pending init promise.
 *
 * Invalid legacy URL → log, still set the marker, create no sub.
 */
export function migrateLegacySubscription(adapter) {
  if (getMarker(adapter) !== null) return { migrated: false, reason: "already-migrated" };

  const row = adapter.get(`SELECT data FROM settings WHERE id = 1`);
  const raw = row ? parseJson(row.data, {}) : {};
  const legacyUrl = typeof raw.xraySubscriptionUrl === "string" ? raw.xraySubscriptionUrl.trim() : "";

  let result = { migrated: true, subId: null, configs: 0 };
  adapter.transaction(() => {
    if (legacyUrl) {
      try {
        const validUrl = validateSubscriptionUrl(legacyUrl);
        const now = new Date().toISOString();
        const res = adapter.run(
          `INSERT INTO xraySubscriptions(name, url, enabled, intervalMin, retentionDays, createdAt, updatedAt)
           VALUES(?, ?, 1, ?, ?, ?, ?)`,
          [
            "Default",
            validUrl,
            raw.xraySyncIntervalMin ?? 60,
            raw.xrayStaleRetentionDays ?? 7,
            now, now,
          ]
        );
        const subId = res?.lastInsertRowid ?? adapter.get(`SELECT id FROM xraySubscriptions WHERE url = ?`, [validUrl])?.id;
        const backfill = adapter.run(
          `INSERT INTO xrayConfigSubscriptions(configId, subscriptionId, lastSeenAt)
           SELECT id, ?, ? FROM xrayConfigs WHERE deletedAt IS NULL`,
          [subId, now]
        );
        result = { migrated: true, subId, configs: backfill?.changes || 0 };
        console.log(`[XraySub] migrated legacy subscription URL → sub #${subId} (${result.configs} configs)`);
      } catch (e) {
        // Invalid legacy URL: marker still set (one-shot), no sub created.
        console.warn(`[XraySub] legacy subscription URL not migrated: ${e.message}`);
      }
    }
    setMarker(adapter);
  });
  return result;
}

function getMarker(adapter) {
  const row = adapter.get(`SELECT value FROM _meta WHERE key = ?`, [LEGACY_SUBS_MARKER]);
  return row ? row.value : null;
}

function setMarker(adapter) {
  adapter.run(
    `INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [LEGACY_SUBS_MARKER, new Date().toISOString()]
  );
}
