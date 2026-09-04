// Phase 02 (X1/X9): reaper scans the real DATA_DIR/xray, matches filter-api
// artifacts (base + overlays) and model-test configs, and never touches the
// live config.json / pid files. Process kills are skipped in this test run.
import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9r-reaper-"));
process.env.DATA_DIR = TEMP_DATA_DIR;

const { reapOrphanedTempProbes } = await import("../../src/lib/xray/reaper.js");

const XRAY_DIR = path.join(TEMP_DATA_DIR, "xray");

function write(name) {
  fs.mkdirSync(XRAY_DIR, { recursive: true });
  fs.writeFileSync(path.join(XRAY_DIR, name), "{}");
  return path.join(XRAY_DIR, name);
}

beforeEach(() => {
  try { fs.rmSync(XRAY_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

process.on("exit", () => {
  try { fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("reapOrphanedTempProbes patterns (X1/X9)", () => {
  it("unlinks model-test configs, filter-api base configs AND their overlays", async () => {
    write("config.json");
    write("xray.pid");
    write("config.json.model-test-abc123.json");
    write("filter-api-51808-51908.json");
    write("filter-api-51808-51908.json.ob-proxy.json");

    const res = await reapOrphanedTempProbes({ skipProcessKill: true });

    expect(res.unlinked).toBe(3);
    expect(fs.existsSync(path.join(XRAY_DIR, "config.json"))).toBe(true);
    expect(fs.existsSync(path.join(XRAY_DIR, "xray.pid"))).toBe(true);
  });

  it("draining registry is removed even when empty of verifiable pids", async () => {
    write("xray.pid.draining");
    // Entries whose pids don't exist are skipped, file still cleared.
    fs.writeFileSync(path.join(XRAY_DIR, "xray.pid.draining"), JSON.stringify([{ pid: 999999999 }]));
    await reapOrphanedTempProbes({ skipProcessKill: true });
    expect(fs.existsSync(path.join(XRAY_DIR, "xray.pid.draining"))).toBe(false);
  });

  it("missing dir is tolerated", async () => {
    const res = await reapOrphanedTempProbes({ xrayDir: path.join(TEMP_DATA_DIR, "nope"), skipProcessKill: true });
    expect(res.unlinked).toBe(0);
  });
});
