import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  json: vi.fn((body, init) => ({ status: init?.status || 200, body })),
  updateSettings: vi.fn(),
}));

// After imports: the vi.mock factory runs lazily, so it can close over this.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reset-pw-setup-code-"));

vi.mock("next/server", () => ({ NextResponse: { json: mocks.json } }));
vi.mock("@/lib/dataDir", () => ({ DATA_DIR: tmpDir }));
vi.mock("@/lib/localDb", () => ({ updateSettings: mocks.updateSettings }));

const { ensureSetupCode, verifyAndConsumeSetupCode } = await import("../../src/lib/auth/setupCode");
const { POST } = await import("../../src/app/api/auth/reset-password/route.js");

describe("POST /api/auth/reset-password — pending setup code hygiene", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.readdirSync(tmpDir).forEach((f) => fs.unlinkSync(path.join(tmpDir, f)));
  });

  it("reset-to-default invalidates a minted-but-unclaimed code", async () => {
    const code = await ensureSetupCode();
    expect(code).toMatch(/^[A-F0-9]{4}-[A-F0-9]{4}$/);

    const res = await POST();

    expect(res.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledWith({ password: null });
    // The old code must be dead: a leak (pasted log, issue comment) must not
    // become a remote takeover after the admin resets back to the default.
    expect(await verifyAndConsumeSetupCode(code)).toBe(false);
  });

  it("still resets successfully when no setup code was ever minted", async () => {
    const res = await POST();

    expect(res.status).toBe(200);
    expect(mocks.updateSettings).toHaveBeenCalledWith({ password: null });
  });
});
