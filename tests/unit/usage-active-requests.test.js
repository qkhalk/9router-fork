// Live active-request tracking must include requests that run WITHOUT a
// connection row (noAuth/free providers like opencode) — otherwise the usage
// topology never lights up for exactly those providers. getActiveRequests
// surfaces them from pendingRequests.byModel with a synthetic account label.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-active-req-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  // Best-effort on Windows: better-sqlite3 may still hold the WAL file open,
  // which makes rmSync EPERM — a leftover temp dir is harmless.
  try {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  } catch { /* locked by open db handle */ }
});

describe("getActiveRequests — connection-less providers", () => {
  it("surfaces pending requests that have no connectionId", async () => {
    db.trackPendingRequest("mimo-v2.5-free", "opencode", undefined, true);
    try {
      const { activeRequests } = await db.getActiveRequests();
      const entry = activeRequests.find((a) => a.provider === "opencode");
      expect(entry).toBeDefined();
      expect(entry.model).toBe("mimo-v2.5-free");
      expect(entry.account).toBe("Free (no connection)");
      expect(entry.count).toBe(1);
    } finally {
      db.trackPendingRequest("mimo-v2.5-free", "opencode", undefined, false);
    }
  });

  it("counts per model+provider and clears when every request finishes", async () => {
    db.trackPendingRequest("m-a", "p1", undefined, true);
    db.trackPendingRequest("m-a", "p1", undefined, true);
    const during = await db.getActiveRequests();
    expect(during.activeRequests.find((a) => a.provider === "p1")?.count).toBe(2);

    db.trackPendingRequest("m-a", "p1", undefined, false);
    db.trackPendingRequest("m-a", "p1", undefined, false);
    const after = await db.getActiveRequests();
    expect(after.activeRequests.find((a) => a.provider === "p1")).toBeUndefined();
  });

  it("does not double-count requests that already carry a connectionId", async () => {
    db.trackPendingRequest("m-b", "p2", "conn-1", true);
    db.trackPendingRequest("m-b", "p2", undefined, true);
    try {
      const { activeRequests } = await db.getActiveRequests();
      const entries = activeRequests.filter((a) => a.provider === "p2");
      const total = entries.reduce((sum, e) => sum + e.count, 0);
      expect(total).toBe(2);
      expect(entries.some((e) => e.account === "Free (no connection)")).toBe(true);
      expect(entries.some((e) => e.account.startsWith("Account "))).toBe(true);
    } finally {
      db.trackPendingRequest("m-b", "p2", "conn-1", false);
      db.trackPendingRequest("m-b", "p2", undefined, false);
    }
  });
});
