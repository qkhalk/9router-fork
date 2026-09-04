// Per-install random secret, persisted 0o600 under DATA_DIR/auth. ONE
// mechanism for everything that needs an unpredictable local secret:
// MITM sudo-password encryption, apiKeys HMAC, and the API_KEY_SECRET
// fallback. Deliberately a leaf module — no jose / bcryptjs / db imports —
// so CLI and worker contexts can use it cheaply. (JWT signing keeps its own
// jwt-secret file + JWT_SECRET env override in dashboardSession.js.)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";

const AUTH_DIR = path.join(DATA_DIR, "auth");
const cache = new Map();

export function getOrCreateInstallSecret(fileName = "install-secret") {
  const hit = cache.get(fileName);
  if (hit) return hit;
  const file = path.join(AUTH_DIR, fileName);
  let secret = null;
  try {
    secret = fs.readFileSync(file, "utf8").trim() || null;
  } catch { /* first run */ }
  if (!secret) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    secret = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(file, secret, { mode: 0o600 });
  }
  cache.set(fileName, secret);
  return secret;
}
