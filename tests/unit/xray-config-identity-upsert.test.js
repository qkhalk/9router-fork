// Cross-subscription identity preservation in bulkUpsertXrayConfigs.
//
// The same canonical share link carried by two subscriptions dedupes into ONE
// xrayConfigs row (id = sha1 of the link without fragment). The upsert must
// keep the identity fields (link/name/country) of the FIRST subscription that
// named the config and never clobber test state — exercised against a REAL
// better-sqlite3 adapter (harness from xray-subscription-repo.test.js).
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-xray-identity-"));
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

async function makeFreshAdapter() {
  fileNo += 1;
  const file = path.join(tempDir, `db-${fileNo}.sqlite`);
  const adapter = createBetterSqliteAdapter(file);
  await runMigrationOnce(adapter);
  state.adapter = adapter;
}

const SUB1_LINK = "vless://uuid@a.example:443?type=ws&path=%2Fsub1#US-Node%201";
const SUB2_LINK = "vless://uuid@a.example:443?type=ws&path=%2Fsub1#Sub2%20Renamed%20DE";

describe("bulkUpsertXrayConfigs — first-namer identity + test-state preservation", () => {
  it("keeps link/name/country of the first sub and never clobbers test state", async () => {
    await makeFreshAdapter();

    await xrayRepo.bulkUpsertXrayConfigs([
      { id: "shared", link: SUB1_LINK, name: "US-Node 1", protocol: "vless", country: "US", host: "a.example", port: 443 },
    ]);
    await xrayRepo.updateXrayTestResult("shared", { latencyMs: 250, exitIp: "1.2.3.4", ok: true });
    await xrayRepo.setSelectedXrayConfig("shared");

    // Sub 2 re-syncs the same canonical link with a different fragment/name.
    await xrayRepo.bulkUpsertXrayConfigs([
      { id: "shared", link: SUB2_LINK, name: "Sub2 Renamed DE", protocol: "vless", country: "DE", host: "a.example", port: 443 },
    ]);

    const cfg = await xrayRepo.getXrayConfigById("shared");
    expect(cfg.name).toBe("US-Node 1");
    expect(cfg.link).toBe(SUB1_LINK);
    expect(cfg.country).toBe("US");
    expect(cfg.lastLatencyMs).toBe(250);
    expect(cfg.lastExitIp).toBe("1.2.3.4");
    expect(cfg.isSelected).toBe(true);
    expect(cfg.isActive).toBe(true);
  });

  it("adopts incoming identity when the existing row has no name yet", async () => {
    await makeFreshAdapter();

    await xrayRepo.bulkUpsertXrayConfigs([
      { id: "anon", link: "vless://uuid@b.example:80", name: "", protocol: "vless", country: "", host: "b.example", port: 80 },
    ]);
    await xrayRepo.bulkUpsertXrayConfigs([
      { id: "anon", link: "vless://uuid@b.example:80#Named%20DE", name: "Named DE", protocol: "vless", country: "DE", host: "b.example", port: 80 },
    ]);

    const cfg = await xrayRepo.getXrayConfigById("anon");
    expect(cfg.name).toBe("Named DE");
    expect(cfg.link).toBe("vless://uuid@b.example:80#Named%20DE");
    expect(cfg.country).toBe("DE");
  });

  it("still inserts brand-new configs normally", async () => {
    await makeFreshAdapter();

    const written = await xrayRepo.bulkUpsertXrayConfigs([
      { id: "fresh", link: SUB1_LINK, name: "US-Node 1", protocol: "vless", country: "US", host: "a.example", port: 443 },
    ]);
    expect(written).toBe(1);
    const cfg = await xrayRepo.getXrayConfigById("fresh");
    expect(cfg.name).toBe("US-Node 1");
    expect(cfg.isActive).toBe(true);
  });
});
