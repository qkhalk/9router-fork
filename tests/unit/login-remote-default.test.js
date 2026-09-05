import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ ok: (init?.status || 200) >= 200 && (init?.status || 200) < 300, status: init?.status || 200, body })),
  cookies: vi.fn(),
  getSettings: vi.fn(),
  isOidcConfigured: vi.fn(() => false),
  isSamlConfigured: vi.fn(() => false),
  isKnownTunnelHost: vi.fn(() => false),
  isLocalRequest: vi.fn(() => false),
  checkLock: vi.fn(() => ({ locked: false })),
  recordFail: vi.fn(() => ({ remainingBeforeLock: 4 })),
  recordSuccess: vi.fn(),
  getClientIp: vi.fn(() => "203.0.113.7"),
  setDashboardAuthCookie: vi.fn(),
  ensureSetupCode: vi.fn(async () => "ABCD-1234"),
}));

vi.mock("next/server", () => ({ NextResponse: { json: mocks.json } }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/lib/auth/oidc", () => ({ isOidcConfigured: mocks.isOidcConfigured }));
vi.mock("@/lib/auth/saml.js", () => ({ isSamlConfigured: mocks.isSamlConfigured }));
vi.mock("@/lib/auth/loginLimiter", () => ({
  checkLock: mocks.checkLock,
  recordFail: mocks.recordFail,
  recordSuccess: mocks.recordSuccess,
  getClientIp: mocks.getClientIp,
}));
vi.mock("@/lib/auth/tunnelAccess", () => ({ isKnownTunnelHost: mocks.isKnownTunnelHost }));
vi.mock("@/dashboardGuard", () => ({ isLocalRequest: mocks.isLocalRequest }));
vi.mock("@/lib/auth/dashboardSession", () => ({ setDashboardAuthCookie: mocks.setDashboardAuthCookie }));
vi.mock("@/lib/auth/setupCode", () => ({ ensureSetupCode: mocks.ensureSetupCode }));
vi.mock("@/lib/dataDir", () => ({ DATA_DIR: "/tmp/9r-login-test" }));

const { POST } = await import("../../src/app/api/auth/login/route.js");

function request(body) {
  return { headers: new Headers(), json: async () => body };
}

describe("POST /api/auth/login — default password on fresh install", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.INITIAL_PASSWORD;
    mocks.getSettings.mockResolvedValue({}); // fresh install: no stored hash
    mocks.isLocalRequest.mockReturnValue(false);
    mocks.cookies.mockResolvedValue({ set: vi.fn() });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("403s for a remote client without issuing a session, and flags setup", async () => {
    const res = await POST(request({ password: "123456" }));

    expect(res.status).toBe(403);
    expect(res.body.mustChangePassword).toBe(true);
    expect(res.body.setupRequired).toBe(true);
    expect(mocks.setDashboardAuthCookie).not.toHaveBeenCalled();
    // A blocked login must NOT clear the lockout bucket, or attackers could
    // alternate setup-code guesses with default-password logins forever.
    expect(mocks.recordSuccess).not.toHaveBeenCalled();
    // The one-time code is minted for the host operator, never sent to the client.
    expect(mocks.ensureSetupCode).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(res.body)).not.toContain("ABCD-1234");
  });

  it("prints the setup code to the console at most once per minute", async () => {
    // Fresh module copy so the print-gate timer starts at zero.
    vi.resetModules();
    const { POST: freshPost } = await import("../../src/app/api/auth/login/route.js");

    await freshPost(request({ password: "123456" }));
    await freshPost(request({ password: "123456" }));

    const codeLogs = vi.mocked(console.log).mock.calls.filter((args) =>
      args.join(" ").includes("ABCD-1234")
    );
    expect(codeLogs.length).toBe(1);
  });

  it("200s with a session for a local client on the same fresh install", async () => {
    mocks.isLocalRequest.mockReturnValue(true);

    const res = await POST(request({ password: "123456" }));

    expect(res.status).toBe(200);
    expect(res.body.mustChangePassword).toBe(false);
    expect(mocks.recordSuccess).toHaveBeenCalledWith("203.0.113.7");
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledTimes(1);
  });

  it("200s remotely when INITIAL_PASSWORD is configured (not public knowledge)", async () => {
    process.env.INITIAL_PASSWORD = "env-pass";

    const res = await POST(request({ password: "env-pass" }));

    expect(res.status).toBe(200);
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledTimes(1);
  });

  it("200s remotely once a real password hash is stored", async () => {
    mocks.getSettings.mockResolvedValue({ password: await bcrypt.hash("hunter2", 4) });

    const res = await POST(request({ password: "hunter2" }));

    expect(res.status).toBe(200);
    expect(mocks.setDashboardAuthCookie).toHaveBeenCalledTimes(1);
  });

  it("401s on a wrong password", async () => {
    const res = await POST(request({ password: "nope" }));

    expect(res.status).toBe(401);
    expect(res.body.remainingBeforeLock).toBe(4);
    expect(mocks.recordFail).toHaveBeenCalledWith("203.0.113.7");
  });
});
