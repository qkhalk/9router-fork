// Phase 5 — API integration story over REAL repos on a REAL SQLite adapter
// (only the network is mocked): create 2 subs → sync each (shared + private
// links, userinfo header) → sub B drops a shared link → cross-sub isolation →
// DELETE sub A with retention 0 → orphan removed, shared config stays.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const state = vi.hoisted(() => ({ adapter: null }));

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => {
    if (!state.adapter) throw new Error("test adapter not ready");
    return state.adapter;
  }),
}));

let tempDir;
let originalDataDir;
let dataFile;

beforeAll(() => {
  originalDataDir = process.env.DATA_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-xray-integration-"));
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

// Route modules (real handlers, real repos underneath)
const { POST: POST_SUBS } = await import("@/app/api/xray/subscriptions/route.js");
const { GET: GET_SUBS } = await import("@/app/api/xray/subscriptions/route.js");
const { DELETE: DELETE_SUB } = await import("@/app/api/xray/subscriptions/[id]/route.js");
const { POST: POST_SYNC } = await import("@/app/api/xray/sync/route.js");
const { GET: GET_CONFIGS } = await import("@/app/api/xray/configs/route.js");

const ID = (link) => createHash("sha1").update(link.slice(0, link.indexOf("#"))).digest("hex");

const L1 = "vless://uuid@shared.example.com:443?type=tcp#v2go | US US | VLESS | 1";   // shared
const L2 = "vless://uuid@only-a.example.com:443?type=tcp#v2go | DE DE | VLESS | 2";   // sub A only
const L3 = "vless://uuid@only-b.example.com:443?type=tcp#b-node";                     // sub B only

beforeEach(() => {
  // Network stub: /api/xray/sync POST for sub 1 → L1+L2 (+userinfo); sub 2 → L1+L3 (drop L2's sibling later).
  globalThis.fetch = vi.fn(async (url) => {
    if (String(url).includes("sub-a.example.com")) {
      return new Response(`${L1}\n${L2}\n`, {
        status: 200,
        headers: { "subscription-userinfo": "upload=1000; download=2000; total=10000; expire=1798761600" },
      });
    }
    if (String(url).includes("sub-b.example.com")) {
      // B drops the shared link on its sync (isolation case below)
      return new Response(`${L3}\n`, { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
});

describe("multi-subscription integration story (routes + real repos)", () => {
  it("create → sync → share → drop → delete with retention", async () => {
    // fresh DB
    dataFile = path.join(tempDir, "integration.sqlite");
    state.adapter = createBetterSqliteAdapter(dataFile);
    await runMigrationOnce(state.adapter);
    // clear the marker so route-created subs are the only source of truth
    state.adapter.run(`DELETE FROM _meta WHERE key LIKE 'xray-subs-migration%'`);

    // 1. create sub A (retention 0 for the delete-later case) + sub B
    const resA = await POST_SUBS(new Request("http://localhost/api/xray/subscriptions", {
      method: "POST",
      body: JSON.stringify({ name: "Airport A", url: "https://sub-a.example.com/sub", retentionDays: 0 }),
    }));
    expect(resA.status).toBe(201);
    const resB = await POST_SUBS(new Request("http://localhost/api/xray/subscriptions", {
      method: "POST",
      body: JSON.stringify({ name: "Airport B", url: "https://sub-b.example.com/sub" }),
    }));
    expect(resB.status).toBe(201);

    // 2. sync A (3s delay-free; mocked fetch) — 2 configs + userinfo persisted
    const syncA = await POST_SYNC(new Request("http://localhost/api/xray/sync", {
      method: "POST",
      body: JSON.stringify({ subscriptionId: 1 }),
    }));
    const bodyA = await syncA.json();
    expect(syncA.status).toBe(200);
    expect(bodyA.results[0].count).toBe(2);

    const subsAfterA = (await (await GET_SUBS()).json()).subscriptions;
    expect(subsAfterA[0].totalBytes).toBe(10000);
    expect(subsAfterA[0].expireAt).toBeTruthy();

    // 3. sync B — L3, and B's fetch does NOT carry L1 yet
    await POST_SYNC(new Request("http://localhost/api/xray/sync", {
      method: "POST",
      body: JSON.stringify({ subscriptionId: 2 }),
    }));

    // 4. shared link lands via A: both sub names badge the same config row
    const configsRes = await GET_CONFIGS(new Request("http://localhost/api/xray/configs?includeDeleted=1"));
    const configsBody = await configsRes.json();
    const byId = new Map(configsBody.configs.map((c) => [c.id, c]));
    const sharedId = ID(L1);
    expect(byId.get(ID(L2)).subs).toContain("Airport A");
    expect(byId.get(ID(L3)).subs).toEqual(["Airport B"]);

    // 5. B's next sync CARRIES L1 (update the stub) → shared badge on both
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("sub-a.example.com")) return new Response(`${L1}\n${L2}\n`, { status: 200 });
      if (String(url).includes("sub-b.example.com")) return new Response(`${L1}\n${L3}\n`, { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    });
    await POST_SYNC(new Request("http://localhost/api/xray/sync", {
      method: "POST",
      body: JSON.stringify({ subscriptionId: 2 }),
    }));
    const afterShare = new Map((await (await GET_CONFIGS(new Request("http://localhost/api/xray/configs"))).json()).configs.map((c) => [c.id, c]));
    expect(afterShare.get(sharedId).subs.sort()).toEqual(["Airport A", "Airport B"]);

    // 6. B drops L1 again → shared config STAYS ACTIVE (A still carries it) — cross-sub isolation
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("sub-a.example.com")) return new Response(`${L1}\n${L2}\n`, { status: 200 });
      if (String(url).includes("sub-b.example.com")) return new Response(`${L3}\n`, { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    });
    await POST_SYNC(new Request("http://localhost/api/xray/sync", {
      method: "POST",
      body: JSON.stringify({ subscriptionId: 2 }),
    }));
    const afterIsolation = new Map((await (await GET_CONFIGS(new Request("http://localhost/api/xray/configs"))).json()).configs.map((c) => [c.id, c]));
    expect(afterIsolation.get(sharedId)).toBeTruthy();
    expect(afterIsolation.get(sharedId).isActive).toBe(true);

    // 6b. B RE-ADOPTS L1 (fetch carries it again) — membership restored
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("sub-a.example.com")) return new Response(`${L1}\n${L2}\n`, { status: 200 });
      if (String(url).includes("sub-b.example.com")) return new Response(`${L1}\n${L3}\n`, { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    });
    await POST_SYNC(new Request("http://localhost/api/xray/sync", {
      method: "POST",
      body: JSON.stringify({ subscriptionId: 2 }),
    }));

    // 7. DELETE sub A (retention 0) → its private config L2 is orphaned → swept;
    //    the shared config L1 stays (B carries it)
    const delRes = await DELETE_SUB(new Request("http://localhost/api/xray/subscriptions/1", { method: "DELETE" }), {
      params: Promise.resolve({ id: "1" }),
    });
    expect(delRes.status).toBe(200);

    const final = new Map((await (await GET_CONFIGS(new Request("http://localhost/api/xray/configs"))).json()).configs.map((c) => [c.id, c]));
    expect(final.has(ID(L2))).toBe(false);  // orphan swept (retention 0)
    expect(final.has(sharedId)).toBe(true); // shared survives via B
    expect(final.has(ID(L3))).toBe(true);
    // sub A's row is gone
    expect((await (await GET_SUBS()).json()).subscriptions.map((s) => s.id)).toEqual([2]);
    // membership rows for sub 1 are gone
    expect(state.adapter.all(`SELECT * FROM xrayConfigSubscriptions WHERE subscriptionId = 1`)).toEqual([]);
  });

  it("manual delete tombstones a config and a re-sync never resurrects it", async () => {
    dataFile = path.join(tempDir, "tombstone.sqlite");
    state.adapter = createBetterSqliteAdapter(dataFile);
    await runMigrationOnce(state.adapter);
    state.adapter.run(`DELETE FROM _meta WHERE key LIKE 'xray-subs-migration%'`);
    globalThis.fetch = vi.fn(async () => new Response(`${L1}\n`, { status: 200 }));

    await POST_SUBS(new Request("http://localhost/api/xray/subscriptions", {
      method: "POST",
      body: JSON.stringify({ name: "S", url: "https://sub-a.example.com/sub" }),
    }));
    await POST_SYNC(new Request("http://localhost/api/xray/sync", { method: "POST", body: "{}" }));
    expect((await (await GET_CONFIGS(new Request("http://localhost/api/xray/configs"))).json()).configs).toHaveLength(1);

    // tombstone via the configs/[id] route
    const { DELETE: DELETE_CONFIG } = await import("@/app/api/xray/configs/[id]/route.js");
    const del = await DELETE_CONFIG(new Request(`http://localhost/api/xray/configs/${ID(L1)}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: ID(L1) }),
    });
    expect(del.status).toBe(200);
    expect((await (await GET_CONFIGS(new Request("http://localhost/api/xray/configs"))).json()).configs).toHaveLength(0);

    // re-sync: the fetch STILL carries the link — the row must stay deleted
    await POST_SYNC(new Request("http://localhost/api/xray/sync", { method: "POST", body: "{}" }));
    const visible = (await (await GET_CONFIGS(new Request("http://localhost/api/xray/configs"))).json()).configs;
    expect(visible).toHaveLength(0);
    // …and the tombstoned row was never swept
    const deletedList = (await (await GET_CONFIGS(new Request("http://localhost/api/xray/configs?includeDeleted=1"))).json()).deleted;
    expect(deletedList).toHaveLength(1);

    // restore via PATCH
    const { PATCH: PATCH_CONFIG } = await import("@/app/api/xray/configs/[id]/route.js");
    const res = await PATCH_CONFIG(new Request(`http://localhost/api/xray/configs/${ID(L1)}`, {
      method: "PATCH", body: JSON.stringify({ restore: true }),
    }), { params: Promise.resolve({ id: ID(L1) }) });
    expect(res.status).toBe(200);
    expect((await (await GET_CONFIGS(new Request("http://localhost/api/xray/configs"))).json()).configs).toHaveLength(1);
  });
});
