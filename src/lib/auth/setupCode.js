// One-time setup code for claiming the initial password on a fresh install.
// The default ("123456") is public knowledge, so a remote caller must never be
// able to rotate the password with it alone — that would let anyone who can
// reach the port take over (CVE-2026-56679 class). The code is a server-side
// secret printed to the server console (docker logs / terminal / journalctl),
// so only someone with host access can complete the claim. Single-use, stored
// 0600 next to the JWT secret.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";

const codeFile = () => path.join(DATA_DIR, "setup-code");

// Returns the pending code, creating (or re-creating after consumption) as
// needed. The caller is responsible for showing it to the host operator.
export async function ensureSetupCode() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const existing = fs.readFileSync(codeFile(), "utf8").trim();
    if (existing) return existing;
  } catch {}
  const raw = crypto.randomBytes(4).toString("hex").toUpperCase();
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  fs.writeFileSync(codeFile(), code, { mode: 0o600 });
  return code;
}

// Constant-time compare; the code is deleted on a match so it can never be
// reused once the password has been claimed.
export async function verifyAndConsumeSetupCode(code) {
  if (typeof code !== "string" || !code.trim()) return false;
  let stored = "";
  try {
    stored = fs.readFileSync(codeFile(), "utf8").trim();
  } catch {
    return false;
  }
  if (!stored) return false;
  const a = Buffer.from(code.trim().toUpperCase());
  const b = Buffer.from(stored.toUpperCase());
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  try {
    fs.unlinkSync(codeFile());
  } catch {}
  return true;
}

export function clearSetupCode() {
  try {
    fs.unlinkSync(codeFile());
  } catch {}
}
