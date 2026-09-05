import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Real DATA_DIR would touch the developer's ~/.9router — redirect to a temp dir.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setup-code-test-"));

vi.mock("@/lib/dataDir", () => ({ DATA_DIR: tmp }));

const { ensureSetupCode, verifyAndConsumeSetupCode, clearSetupCode } = await import("../../src/lib/auth/setupCode");

describe("setup-code lib", () => {
  beforeEach(() => {
    clearSetupCode();
  });

  it("mints a code in XXXX-XXXX hex format and persists it", async () => {
    const code = await ensureSetupCode();
    expect(code).toMatch(/^[A-F0-9]{4}-[A-F0-9]{4}$/);
    // Second call returns the same pending code (idempotent).
    expect(await ensureSetupCode()).toBe(code);
  });

  it("accepts the correct code case-insensitively and consumes it once", async () => {
    const code = await ensureSetupCode();
    expect(await verifyAndConsumeSetupCode(code.toLowerCase())).toBe(true);
    // Single-use: replay is rejected.
    expect(await verifyAndConsumeSetupCode(code)).toBe(false);
  });

  it("rejects a wrong code without consuming the real one", async () => {
    const code = await ensureSetupCode();
    expect(await verifyAndConsumeSetupCode("FFFF-FFFF")).toBe(false);
    expect(await verifyAndConsumeSetupCode(code)).toBe(true);
  });

  it("rejects wrong-length and missing codes without throwing", async () => {
    await ensureSetupCode();
    await expect(verifyAndConsumeSetupCode("ABCD")).resolves.toBe(false);
    await expect(verifyAndConsumeSetupCode("")).resolves.toBe(false);
    await expect(verifyAndConsumeSetupCode(undefined)).resolves.toBe(false);
  });

  it("mints a fresh code after consumption (old code never resurrects)", async () => {
    const first = await ensureSetupCode();
    await verifyAndConsumeSetupCode(first);
    const second = await ensureSetupCode();
    expect(second).not.toBe(first);
    expect(await verifyAndConsumeSetupCode(first)).toBe(false);
    expect(await verifyAndConsumeSetupCode(second)).toBe(true);
  });

  it("returns false when no code was ever minted", async () => {
    expect(await verifyAndConsumeSetupCode("AAAA-BBBB")).toBe(false);
  });
});
