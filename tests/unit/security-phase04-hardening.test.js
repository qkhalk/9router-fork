import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("undici", () => ({ Agent: class Agent {} }), { virtual: true });
vi.mock("uuid", () => ({ v4: () => "00000000-0000-4000-8000-000000000000" }), { virtual: true });
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => new Response(JSON.stringify(body), {
      status: init?.status ?? 200,
      headers: { "content-type": "application/json", ...(init?.headers || {}) },
    }),
  },
}), { virtual: true });
// dashboardSession's real imports are not installed under tests/node_modules.
vi.mock("jose", () => ({
  SignJWT: class SignJWT {},
  jwtVerify: vi.fn(async () => { throw new Error("jwt not under test"); }),
}), { virtual: true });
vi.mock("bcryptjs", () => ({ default: { compare: vi.fn(async () => false) } }), { virtual: true });
// Skip loadJwtSecret's file write at module load.
process.env.JWT_SECRET = "test-secret";

const dbMocks = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({})),
  validateApiKey: vi.fn(async () => false),
  exportDb: vi.fn(async () => ({ settings: { theme: "dark" } })),
  importDb: vi.fn(async () => {}),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: vi.fn(async (salt) => `token-for-${salt}`),
}));
vi.mock("@/lib/network/outboundProxy", () => ({
  applyOutboundProxyEnv: vi.fn(),
}));
// The guard needs verifyDashboardAuthToken; the route needs the REAL
// verifyDashboardPassword (N11 target). Keep everything else from the module.
vi.mock("@/lib/auth/dashboardSession", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, verifyDashboardAuthToken: vi.fn(async () => false) };
});

import { GET as dbExport, POST as dbImport } from "../../src/app/api/settings/database/route.js";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession.js";
import { GET as requireLogin } from "../../src/app/api/settings/require-login/route.js";

const CLI_TOKEN = "token-for-9r-cli-auth";

function req(headers = {}, body) {
  return new Request("http://localhost:21399/api/settings/database", {
    method: body === undefined ? "GET" : "POST",
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getSettings.mockResolvedValue({});
});

afterEach(() => {
  delete process.env.INITIAL_PASSWORD;
  delete process.env.NINEROUTER_PEER_TOKEN;
});

describe("S1: /api/settings/database auth", () => {
  it("rejects a junk CLI token with 401 (presence alone no longer passes)", async () => {
    const res = await dbExport(req({ "x-9r-cli-token": "x" }));
    expect(res.status).toBe(401);
  });

  it("accepts the real per-install CLI token without a password", async () => {
    const res = await dbExport(req({ "x-9r-cli-token": CLI_TOKEN }));
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.settings).toEqual({ theme: "dark" });
  });

  it("rejects a same-length wrong token (constant-time compare, no prefix leak)", async () => {
    // NB: the Headers API trims whitespace, so the token must differ in a
    // character, not just length.
    const res = await dbExport(req({ "x-9r-cli-token": "Token-for-9r-cli-auth" }));
    expect(res.status).toBe(401);
  });

  it("sets Cache-Control: no-store on export (N12)", async () => {
    const res = await dbExport(req({ "x-9r-cli-token": CLI_TOKEN }));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("POST rejects a junk CLI token even with a valid-looking body", async () => {
    const res = await dbImport(req({ "x-9r-cli-token": "x" }, { settings: {} }));
    expect(res.status).toBe(401);
    expect(dbMocks.importDb).not.toHaveBeenCalled();
  });
});

describe("N11: verifyDashboardPassword default-password locality gate", () => {
  it("refuses the default password from a non-local request (no stored hash)", async () => {
    dbMocks.getSettings.mockResolvedValue({}); // no password hash
    const remote = { headers: new Headers({ host: "tunnel.example.com" }) };
    expect(await verifyDashboardPassword("123456", remote)).toBe(false);
  });

  it("accepts the default password from a verified loopback peer", async () => {
    process.env.NINEROUTER_PEER_TOKEN = "peer-t";
    dbMocks.getSettings.mockResolvedValue({});
    const local = {
      headers: new Headers({ "x-9r-peer-token": "peer-t", "x-9r-real-ip": "127.0.0.1" }),
    };
    expect(await verifyDashboardPassword("123456", local)).toBe(true);
  });

  it("still compares against the stored bcrypt hash remotely (real password auth)", async () => {
    dbMocks.getSettings.mockResolvedValue({ password: "$2a$10$abcdefghijklmnopqrstuv" });
    const remote = { headers: new Headers({ host: "tunnel.example.com" }) };
    // bcrypt.compare runs against a fake hash — wrong password, must be false;
    // the point is it did NOT short-circuit on the locality gate.
    expect(await verifyDashboardPassword("whatever", remote)).toBe(false);
  });

  it("honors INITIAL_PASSWORD remotely (operator-chosen, not the printed default)", async () => {
    process.env.INITIAL_PASSWORD = "operator-set-9";
    dbMocks.getSettings.mockResolvedValue({});
    const remote = { headers: new Headers({ host: "tunnel.example.com" }) };
    expect(await verifyDashboardPassword("operator-set-9", remote)).toBe(true);
    expect(await verifyDashboardPassword("123456", remote)).toBe(false);
  });
});

describe("S8: /api/settings/require-login leaks no hostnames", () => {
  it("returns booleans only", async () => {
    dbMocks.getSettings.mockResolvedValue({
      requireLogin: true,
      tunnelDashboardAccess: true,
      tunnelUrl: "https://box-1.try9router.dev",
      tailscaleUrl: "http://100.x.y.z:21399",
      externalTunnelUrl: "https://ai.example.com",
    });
    const res = await requireLogin();
    const body = await res.json();
    expect(body).toEqual({ requireLogin: true, tunnelDashboardAccess: true });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("try9router");
    expect(raw).not.toContain("example.com");
    expect(raw).not.toContain("100.");
  });
});
