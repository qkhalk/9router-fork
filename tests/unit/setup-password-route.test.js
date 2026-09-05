import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  checkLock: vi.fn(() => ({ locked: false })),
  recordFail: vi.fn(() => ({ remainingBeforeLock: 4 })),
  recordSuccess: vi.fn(),
  getClientIp: vi.fn(() => "203.0.113.7"),
}));

// After imports: vi.mock factories run lazily, so they can close over this.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-password-route-"));

vi.mock("next/server", () => ({ NextResponse: { json: mocks.json } }));
vi.mock("@/lib/dataDir", () => ({ DATA_DIR: tmpDir }));
vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}));
vi.mock("@/lib/auth/loginLimiter", () => ({
  checkLock: mocks.checkLock,
  recordFail: mocks.recordFail,
  recordSuccess: mocks.recordSuccess,
  getClientIp: mocks.getClientIp,
}));

const { ensureSetupCode } = await import("../../src/lib/auth/setupCode");
const { POST } = await import("../../src/app/api/auth/setup-password/route.js");

function request(body) {
  return { headers: new Headers(), json: async () => body };
}

describe("POST /api/auth/setup-password", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.INITIAL_PASSWORD;
    fs.readdirSync(tmpDir).forEach((f) => fs.unlinkSync(path.join(tmpDir, f)));
    mocks.getSettings.mockResolvedValue({}); // fresh install: no stored hash
  });

  it("sets the password and consumes the code on a valid claim", async () => {
    const code = await ensureSetupCode();

    const res = await POST(request({ password: "123456", setupCode: code, newPassword: "s3cret!" }));

    expect(res.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledTimes(1);
    const stored = mocks.updateSettings.mock.calls[0][0].password;
    expect(stored).not.toBe("s3cret!");
    await expect(bcrypt.compare("s3cret!", stored)).resolves.toBe(true);
    // Single use: replay claim is rejected.
    const replay = await POST(request({ password: "123456", setupCode: code, newPassword: "other-pass" }));
    expect(replay.status).toBe(403);
    expect(mocks.recordSuccess).toHaveBeenCalledWith("203.0.113.7");
  });

  it("returns 403 and records a fail on a wrong setup code", async () => {
    await ensureSetupCode();

    const res = await POST(request({ password: "123456", setupCode: "0000-0000", newPassword: "s3cret!" }));

    expect(res.status).toBe(403);
    expect(mocks.recordFail).toHaveBeenCalledWith("203.0.113.7");
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("returns 403 when the default password does not match", async () => {
    const code = await ensureSetupCode();

    const res = await POST(request({ password: "wrong", setupCode: code, newPassword: "s3cret!" }));

    expect(res.status).toBe(403);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("rejects an empty or default new password without consuming the code", async () => {
    const code = await ensureSetupCode();

    const empty = await POST(request({ password: "123456", setupCode: code, newPassword: "" }));
    const defaultPw = await POST(request({ password: "123456", setupCode: code, newPassword: "123456" }));

    expect(empty.status).toBe(400);
    expect(defaultPw.status).toBe(400);
    // The code must still work for a proper attempt afterwards.
    const retry = await POST(request({ password: "123456", setupCode: code, newPassword: "s3cret!" }));
    expect(retry.status).toBe(200);
  });

  it("404s once a password hash exists (endpoint only exists on fresh install)", async () => {
    mocks.getSettings.mockResolvedValue({ password: "$2a$10$alreadyhashed" });

    const res = await POST(request({ password: "123456", setupCode: "AAAA-BBBB", newPassword: "s3cret!" }));

    expect(res.status).toBe(404);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("404s when INITIAL_PASSWORD is configured (nothing to claim)", async () => {
    process.env.INITIAL_PASSWORD = "env-pass";

    const res = await POST(request({ password: "123456", setupCode: "AAAA-BBBB", newPassword: "s3cret!" }));

    expect(res.status).toBe(404);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("429s while the IP is locked out", async () => {
    mocks.checkLock.mockReturnValue({ locked: true, retryAfter: 30 });

    const res = await POST(request({ password: "123456", setupCode: "AAAA-BBBB", newPassword: "s3cret!" }));

    expect(res.status).toBe(429);
    expect(res.body.retryAfter).toBe(30);
  });
});
