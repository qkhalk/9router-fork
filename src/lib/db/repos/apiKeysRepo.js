import { v4 as uuidv4 } from "uuid";
import crypto from "node:crypto";
import { getAdapter } from "../driver.js";
import { getOrCreateInstallSecret } from "@/lib/auth/installSecret.js";

// S7: raw API keys are never stored. Lookup key = HMAC-SHA256(raw key,
// per-install secret); the legacy plaintext `key` column survives only as a
// masked display value after lazy backfill.
function hashApiKey(rawKey) {
  const secret = getOrCreateInstallSecret("api-keys-hmac");
  return crypto.createHmac("sha256", secret).update(String(rawKey)).digest("hex");
}

// Masked display form keeps the unique keyId (no UNIQUE collision on the
// display column) plus the last 4 chars for recognition.
function maskApiKey(rawKey) {
  const k = String(rawKey);
  const parts = k.split("-");
  const keyId = parts.length >= 3 ? parts[parts.length - 2] : "??????";
  const last4 = k.slice(-4);
  return `sk-${keyId}-••••${last4}`;
}

export { hashApiKey, maskApiKey };

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    // Hashed rows carry the masked display value already; a not-yet-migrated
    // legacy row still holds the raw key — mask at read so listings and the
    // API never expose it.
    key: row.keyHash ? row.key : maskApiKey(row.key),
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(),
    name,
    key: maskApiKey(result.key), // stored masked; the raw key is returned ONCE below
    machineId,
    isActive: true,
    createdAt: new Date().toISOString(),
  };
  db.run(
    `INSERT INTO apiKeys(id, key, keyHash, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, hashApiKey(result.key), apiKey.name, apiKey.machineId, 1, apiKey.createdAt]
  );
  // Full key only in the creation result, so the UI can show it exactly once.
  return { ...apiKey, key: result.key };
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    // `key` is a display value now — callers rename/toggle; they never rotate
    // the secret through this path, and an incoming `key` is ignored rather
    // than written (it would desync from keyHash).
    db.run(
      `UPDATE apiKeys SET name = ?, machineId = ?, isActive = ? WHERE id = ?`,
      [merged.name, merged.machineId, merged.isActive ? 1 : 0, id]
    );
    result = merged;
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  if (!key) return false;
  const db = await getAdapter();
  const isActive = (row) => row.isActive === 1 || row.isActive === true;

  // 1. Hash-first: the normal path for migrated/created keys.
  const row = db.get(`SELECT isActive FROM apiKeys WHERE keyHash = ?`, [hashApiKey(key)]);
  if (row) return isActive(row);

  // 2. Legacy plaintext fallback + lazy backfill (one transaction): the key
  //    keeps working whether or not the backfill write succeeds.
  const legacy = db.get(`SELECT id, isActive, key FROM apiKeys WHERE key = ?`, [key]);
  if (!legacy) return false;
  if (isActive(legacy)) {
    try {
      db.transaction(() => {
        db.run(`UPDATE apiKeys SET keyHash = ?, key = ? WHERE id = ?`, [
          hashApiKey(key),
          maskApiKey(key),
          legacy.id,
        ]);
      });
    } catch (err) {
      console.warn("[apiKeys] lazy hash backfill failed (key remains usable):", err?.message);
    }
  }
  return isActive(legacy);
}
