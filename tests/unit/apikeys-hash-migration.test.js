import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });

// In-memory adapter standing in for the SQLite driver — only what the repo uses.
const state = vi.hoisted(() => ({ rows: new Map(), runs: [] }));

function fakeAdapter() {
  return {
    get(sql, params = []) {
      if (sql.includes("FROM apiKeys WHERE keyHash")) {
        for (const r of state.rows.values()) if (r.keyHash === params[0]) return r;
        return undefined;
      }
      if (sql.includes("FROM apiKeys WHERE key = ?")) {
        for (const r of state.rows.values()) if (r.key === params[0]) return r;
        return undefined;
      }
      if (sql.includes("FROM apiKeys WHERE id")) {
        return state.rows.get(params[0]);
      }
      return undefined;
    },
    all() {
      return [...state.rows.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    },
    run(sql, params = []) {
      state.runs.push({ sql, params });
      if (sql.startsWith("INSERT INTO apiKeys")) {
        state.rows.set(params[0], {
          id: params[0], key: params[1], keyHash: params[2], name: params[3],
          machineId: params[4], isActive: params[5], createdAt: params[6],
        });
        return { changes: 1 };
      }
      if (sql.startsWith("UPDATE apiKeys SET keyHash")) {
        const row = state.rows.get(params[2]);
        if (row) { row.keyHash = params[0]; row.key = params[1]; }
        return { changes: row ? 1 : 0 };
      }
      return { changes: 0 };
    },
    transaction(fn) { fn(); },
  };
}

vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: vi.fn(async () => fakeAdapter()) }));
// Deterministic per-install secret for the HMAC assertions.
vi.mock("@/lib/auth/installSecret.js", () => ({
  getOrCreateInstallSecret: () => "test-install-secret",
}));

import crypto from "node:crypto";
import {
  createApiKey, validateApiKey, getApiKeys, maskApiKey, hashApiKey,
} from "../../src/lib/db/repos/apiKeysRepo.js";

const RAW_KEY = "sk-machine1234-ab12cd-9f8e7d6c";

// The repo generates keys via generateApiKeyWithMachine; pin its output.
vi.mock("@/shared/utils/apiKey", () => ({
  generateApiKeyWithMachine: () => ({ key: RAW_KEY, keyId: "ab12cd" }),
}));

const hmacOf = (key) => crypto.createHmac("sha256", "test-install-secret").update(key).digest("hex");

beforeEach(() => {
  state.rows.clear();
  state.runs.length = 0;
});

describe("apiKeys hash-at-rest (S7)", () => {
  it("createApiKey stores only the hash + masked display value, returns the raw key once", async () => {
    const created = await createApiKey("ci", "machine1234");
    const row = state.rows.get(created.id);
    expect(row.keyHash).toBe(hmacOf(RAW_KEY));
    expect(row.key).toBe("sk-ab12cd-••••7d6c");
    expect(row.key).not.toContain(RAW_KEY);
    expect(created.key).toBe(RAW_KEY); // caller sees it exactly once
  });

  it("validateApiKey hits the hash index (no plaintext lookup on the hot path)", async () => {
    await createApiKey("ci", "machine1234");
    expect(await validateApiKey(RAW_KEY)).toBe(true);
    // No WHERE key = ? scan happened — only the hash lookup.
    expect(state.runs.some((r) => r.sql.includes("WHERE key = ?") && r.sql.startsWith("SELECT"))).toBe(false);
  });

  it("rejects a wrong key", async () => {
    await createApiKey("ci", "machine1234");
    expect(await validateApiKey("sk-machine1234-ab12cd-00000000")).toBe(false);
  });

  it("validates a legacy plaintext row AND lazily backfills hash + mask", async () => {
    state.rows.set("legacy-1", {
      id: "legacy-1", key: RAW_KEY, keyHash: null,
      name: "old", machineId: "machine1234", isActive: 1, createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await validateApiKey(RAW_KEY)).toBe(true);

    const row = state.rows.get("legacy-1");
    expect(row.keyHash).toBe(hmacOf(RAW_KEY));
    expect(row.key).toBe("sk-ab12cd-••••7d6c"); // plaintext cleared
    expect(row.key).not.toBe(RAW_KEY);

    // Second validate goes through the hash path.
    expect(await validateApiKey(RAW_KEY)).toBe(true);
  });

  it("does not backfill an inactive legacy key but still reports inactive", async () => {
    state.rows.set("legacy-2", {
      id: "legacy-2", key: RAW_KEY, keyHash: null,
      name: "old", machineId: "machine1234", isActive: 0, createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await validateApiKey(RAW_KEY)).toBe(false);
    expect(state.rows.get("legacy-2").keyHash).toBeNull();
  });

  it("listings never expose a raw legacy key (masked at read)", async () => {
    state.rows.set("legacy-3", {
      id: "legacy-3", key: RAW_KEY, keyHash: null,
      name: "old", machineId: "machine1234", isActive: 1, createdAt: "2026-01-01T00:00:00.000Z",
    });
    const keys = await getApiKeys();
    const listed = keys.find((k) => k.id === "legacy-3");
    expect(listed.key).toBe("sk-ab12cd-••••7d6c");
    expect(JSON.stringify(keys)).not.toContain(RAW_KEY);
  });

  it("helpers: hash is HMAC over the install secret; mask keeps keyId + last4", () => {
    expect(hashApiKey("k")).toBe(hmacOf("k"));
    expect(maskApiKey(RAW_KEY)).toBe("sk-ab12cd-••••7d6c");
  });
});
