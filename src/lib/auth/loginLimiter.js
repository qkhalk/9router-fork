// Progressive lockout for dashboard login. State lives in memory and is
// persisted best-effort to DATA_DIR/login-lockout.json so a restart (or a
// crash-loop) no longer resets every bucket — the audit 2026-09-30 finding:
// internet-exposed installs had their brute-force window reopened by any
// process restart. Persistence is a safety net, never a source of truth: an
// unreadable or corrupt file falls back to an empty map and login keeps
// working.
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir";
import { hasTrustedPeerHeaders } from "./trustedPeer.js";

const MAX_FAILS_BEFORE_LOCK = 5;
const LOCK_STEPS_MS = [30_000, 120_000, 600_000, 1_800_000]; // 30s, 2m, 10m, 30m
const FAIL_WINDOW_MS = 60 * 60 * 1000; // 1h since last fail → auto reset

const LOCKOUT_FILE = path.join(DATA_DIR, "login-lockout.json");
const PERSIST_DEBOUNCE_MS = 1_500;

const attempts = new Map(); // ip → { fails, lockUntil, lockLevel, lastFailAt }

function now() { return Date.now(); }

function loadPersisted() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCKOUT_FILE, "utf8"));
    for (const [ip, e] of Object.entries(raw || {})) {
      if (e && typeof e === "object" && Number.isFinite(e.lastFailAt)) attempts.set(ip, e);
    }
  } catch { /* no state yet, or unreadable — start empty */ }
}
loadPersisted();

let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const cutoff = now() - FAIL_WINDOW_MS;
      const entries = {};
      for (const [ip, e] of attempts) {
        if (e.lastFailAt >= cutoff || (e.lockUntil && e.lockUntil > now())) entries[ip] = e;
      }
      const tmp = `${LOCKOUT_FILE}.tmp`;
      fs.mkdirSync(path.dirname(LOCKOUT_FILE), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(entries));
      fs.renameSync(tmp, LOCKOUT_FILE);
    } catch { /* best-effort only — lockout still works in-memory */ }
  }, PERSIST_DEBOUNCE_MS);
  if (typeof saveTimer.unref === "function") saveTimer.unref();
}

function getEntry(ip) {
  const e = attempts.get(ip);
  if (!e) return null;
  // Auto reset if window expired and not currently locked
  if (e.lastFailAt && now() - e.lastFailAt > FAIL_WINDOW_MS && (!e.lockUntil || now() >= e.lockUntil)) {
    attempts.delete(ip);
    return null;
  }
  return e;
}

export function checkLock(ip) {
  const e = getEntry(ip);
  if (!e || !e.lockUntil) return { locked: false };
  const remaining = e.lockUntil - now();
  if (remaining <= 0) return { locked: false };
  return { locked: true, retryAfter: Math.ceil(remaining / 1000) };
}

export function recordFail(ip) {
  const e = getEntry(ip) || { fails: 0, lockUntil: 0, lockLevel: 0, lastFailAt: 0 };
  e.fails += 1;
  e.lastFailAt = now();
  if (e.fails >= MAX_FAILS_BEFORE_LOCK) {
    const step = LOCK_STEPS_MS[Math.min(e.lockLevel, LOCK_STEPS_MS.length - 1)];
    e.lockUntil = now() + step;
    e.lockLevel += 1;
    e.fails = 0;
  }
  attempts.set(ip, e);
  persist();
  return { remainingBeforeLock: Math.max(0, MAX_FAILS_BEFORE_LOCK - e.fails) };
}

export function recordSuccess(ip) {
  attempts.delete(ip);
  persist();
}

export function getClientIp(request) {
  // Trusted only when custom-server.js proves it stamped the header from the TCP socket;
  // otherwise a client could rotate the value to escape its own lockout bucket.
  if (hasTrustedPeerHeaders(request)) {
    const realIp = request.headers.get("x-9r-real-ip");
    if (realIp) return realIp;
  }
  // Behind a trusted reverse proxy that overwrites XFF with the real client IP.
  if (process.env.TRUST_PROXY === "true") {
    const xff = request.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
  }
  // Direct exposure without custom-server: single bucket so spoofed XFF
  // rotation cannot escape the limiter.
  return "unknown";
}
