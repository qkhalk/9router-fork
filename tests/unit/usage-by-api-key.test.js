// Regression tests for /dashboard/usage "Usage by API Key".
//
// Keys are `sk-{machineId}-{keyId}-{crc}` — every key on one machine shares
// the same first 8 chars. The stats aggregation must keep per-key rows
// distinct (masked-prefix keys used to collide and merge all keys into one).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-usagekey-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

function mkEntry(overrides = {}, i = 0) {
  return {
    provider: "claude",
    model: "claude-sonnet-4",
    tokens: { prompt_tokens: 100 + i, completion_tokens: 10 + i },
    timestamp: new Date(Date.now() - i * 1000).toISOString(),
    connectionId: "conn-1",
    endpoint: "/v1/messages",
    ...overrides,
  };
}

async function setup() {
  const { saveRequestUsage, getUsageStats } = await import("@/lib/db/repos/usageRepo.js");
  const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
  return { saveRequestUsage, getUsageStats, createApiKey };
}

describe("getUsageStats byApiKey", () => {
  it("today: keeps rows distinct for keys sharing the same 8-char prefix", async () => {
    const { saveRequestUsage, getUsageStats, createApiKey } = await setup();
    // Same machineId → both keys start with the identical 8 chars
    const keyA = await createApiKey("Key A", "machine12345678");
    const keyB = await createApiKey("Key B", "machine12345678");
    expect(keyA.key.slice(0, 8)).toBe(keyB.key.slice(0, 8));

    await saveRequestUsage(mkEntry({ apiKey: keyA.key }, 0));
    await saveRequestUsage(mkEntry({ apiKey: keyA.key }, 1));
    await saveRequestUsage(mkEntry({ apiKey: keyA.key }, 2));
    await saveRequestUsage(mkEntry({ apiKey: keyB.key }, 3));
    await saveRequestUsage(mkEntry({ apiKey: keyB.key }, 4));

    const stats = await getUsageStats("today");
    const rows = Object.values(stats.byApiKey);
    expect(rows).toHaveLength(2);

    const byName = Object.fromEntries(rows.map((r) => [r.keyName, r]));
    expect(byName["Key A"].requests).toBe(3);
    expect(byName["Key B"].requests).toBe(2);
    expect(byName["Key A"].apiKeyKey).not.toBe(byName["Key B"].apiKeyKey);

    // Raw keys must never leak into the API response
    const serialized = JSON.stringify(stats);
    expect(serialized).not.toContain(keyA.key);
    expect(serialized).not.toContain(keyB.key);
  });

  it("today: same key across models aggregates under one keyName but distinct rows", async () => {
    const { saveRequestUsage, getUsageStats, createApiKey } = await setup();
    const keyA = await createApiKey("Key A", "machine12345678");

    await saveRequestUsage(mkEntry({ apiKey: keyA.key }, 0));
    await saveRequestUsage(mkEntry({ apiKey: keyA.key, model: "claude-opus-4" }, 1));

    const stats = await getUsageStats("today");
    const rows = Object.values(stats.byApiKey);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.keyName).toBe("Key A");
  });

  it("today: deleted keys get unique fallback names and stay separate", async () => {
    const { saveRequestUsage, getUsageStats } = await setup();
    const ghost1 = "sk-machine12345678-abc123-deadbeef01";
    const ghost2 = "sk-machine12345678-xyz789-cafebeef02";

    await saveRequestUsage(mkEntry({ apiKey: ghost1 }, 0));
    await saveRequestUsage(mkEntry({ apiKey: ghost1 }, 1));
    await saveRequestUsage(mkEntry({ apiKey: ghost2 }, 2));

    const stats = await getUsageStats("today");
    const rows = Object.values(stats.byApiKey);
    expect(rows).toHaveLength(2);
    const names = rows.map((r) => r.keyName);
    expect(names[0]).not.toBe(names[1]);
    expect(rows.find((r) => r.requests === 2)?.keyName).toBe(names.find((n) => n.includes(ghost1.slice(0, 8))));
  });

  it("today: no-key usage keeps one row per model instead of a single merged row", async () => {
    const { saveRequestUsage, getUsageStats } = await setup();

    await saveRequestUsage(mkEntry({ apiKey: undefined, connectionId: undefined }, 0));
    await saveRequestUsage(mkEntry({ apiKey: undefined, connectionId: undefined, model: "claude-opus-4" }, 1));

    const stats = await getUsageStats("today");
    const rows = Object.values(stats.byApiKey);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.keyName).toBe("Local (No API Key)");
      expect(r.requests).toBe(1);
    }
    expect(rows.some((r) => r.rawModel === "claude-sonnet-4")).toBe(true);
    expect(rows.some((r) => r.rawModel === "claude-opus-4")).toBe(true);
  });

  it("7d (daily summary): per-key rows distinct, deleted keys unmerged, no raw-key leak", async () => {
    const { saveRequestUsage, getUsageStats, createApiKey } = await setup();
    const keyA = await createApiKey("Key A", "machine12345678");
    const keyB = await createApiKey("Key B", "machine12345678");
    const ghost = "sk-machine12345678-aaa111-bbbbcccc01";

    await saveRequestUsage(mkEntry({ apiKey: keyA.key }, 0));
    await saveRequestUsage(mkEntry({ apiKey: keyA.key }, 1));
    await saveRequestUsage(mkEntry({ apiKey: keyB.key }, 2));
    await saveRequestUsage(mkEntry({ apiKey: ghost }, 3));
    await saveRequestUsage(mkEntry({ apiKey: undefined, connectionId: undefined }, 4));

    const stats = await getUsageStats("7d");
    const rows = Object.values(stats.byApiKey);
    // keyA, keyB, ghost, local-no-key → 4 distinct rows for one model
    expect(rows).toHaveLength(4);

    const byName = Object.fromEntries(rows.map((r) => [r.keyName, r]));
    expect(byName["Key A"].requests).toBe(2);
    expect(byName["Key B"].requests).toBe(1);
    expect(byName["Local (No API Key)"].requests).toBe(1);

    const serialized = JSON.stringify(stats);
    expect(serialized).not.toContain(keyA.key);
    expect(serialized).not.toContain(keyB.key);
    expect(serialized).not.toContain(ghost);
  });
});
