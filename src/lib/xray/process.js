/**
 * Managed xray-core child process lifecycle.
 *
 * Mirrors the proven pattern from src/lib/headroom/process.js: detached spawn
 * with PID file, startup gate (process must survive N ms to count as started),
 * SIGTERM → SIGKILL escalation, and Windows-safe killing via taskkill.
 *
 * One xray process = one active outbound (the v2rayN convention). Switching
 * servers is kill + respawn with a new config.json — simpler and leak-free
 * compared to the gRPC HandlerService reload path.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, execFile, exec } from "node:child_process";
import { DATA_DIR } from "@/lib/dataDir.js";
import { getXrayBinaryPath, isXrayInstalled } from "./installer.js";

const XRAY_DIR = path.join(DATA_DIR, "xray");
const PID_FILE = path.join(XRAY_DIR, "xray.pid");
const LOG_FILE = path.join(XRAY_DIR, "xray.log");
const STARTUP_TIMEOUT_MS = 8000;

function ensureDir() {
  if (!fs.existsSync(XRAY_DIR)) fs.mkdirSync(XRAY_DIR, { recursive: true });
}

function readPid() {
  try {
    if (fs.existsSync(PID_FILE)) return parseInt(fs.readFileSync(PID_FILE, "utf8"), 10);
  } catch { /* ignore */ }
  return null;
}

function writePid(pid) {
  ensureDir();
  fs.writeFileSync(PID_FILE, String(pid));
}

function clearPid() {
  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

/** Probe whether a pid is alive (process.kill with signal 0 throws if dead). */
export function isPidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Returns the managed pid only if the pid file exists AND the process is alive. */
export function getManagedPid() {
  const pid = readPid();
  return pid && isPidAlive(pid) ? pid : null;
}

/**
 * Start a managed xray process bound to the given config file.
 * Idempotent: if a managed process is already running, returns it as-is.
 *
 * @param {{ configPath: string }} opts
 * @returns {{ pid: number, alreadyRunning: boolean }}
 * @throws {Error} with code NOT_INSTALLED if the binary is missing,
 *                 code SPAWN_FAILED / EARLY_EXIT on startup failure.
 */
export async function startManagedXray({ configPath }) {
  if (!isXrayInstalled()) {
    const err = new Error("Xray binary not installed");
    err.code = "NOT_INSTALLED";
    throw err;
  }

  const existing = getManagedPid();
  if (existing) return { pid: existing, alreadyRunning: true };

  ensureDir();
  const binary = getXrayBinaryPath();
  const outFd = fs.openSync(LOG_FILE, "a");

  const child = spawn(binary, ["run", "-c", configPath], {
    stdio: ["ignore", outFd, outFd],
    detached: true,
    windowsHide: true,
    env: { ...process.env },
  });

  if (!child.pid) {
    fs.closeSync(outFd);
    const err = new Error("Failed to spawn xray process");
    err.code = "SPAWN_FAILED";
    throw err;
  }

  child.unref();
  writePid(child.pid);

  // Startup gate: the process must stay alive past STARTUP_TIMEOUT_MS. A fast
  // exit (bad config, port conflict, missing assets) rejects with EARLY_EXIT.
  await new Promise((resolve, reject) => {
    const startupTimer = setTimeout(() => {
      if (isPidAlive(child.pid)) resolve();
      else reject(new Error("xray exited during startup — see xray.log"));
    }, STARTUP_TIMEOUT_MS);

    child.once("exit", (code) => {
      clearTimeout(startupTimer);
      clearPid();
      try { fs.closeSync(outFd); } catch {}
      const e = new Error(`xray exited early (code=${code}) — see xray.log`);
      e.code = "EARLY_EXIT";
      e.exitCode = code;
      reject(e);
    });
  });

  try { fs.closeSync(outFd); } catch {}
  return { pid: child.pid, alreadyRunning: false };
}

/**
 * Stop the managed xray process. Sends SIGTERM, escalates to SIGKILL after 2s.
 * On Windows, uses PowerShell Stop-Process (more reliable than taskkill in
 * Git Bash environments where taskkill can silently fail).
 *
 * @returns {{ stopped: boolean, pid?: number, reason?: string }}
 */
export function stopXray() {
  const pid = getManagedPid();
  if (!pid) return { stopped: false, reason: "not_running" };

  try {
    if (process.platform === "win32") {
      // PowerShell Stop-Process is more reliable than taskkill across shells.
      // /F equivalent = -Force. Fire and forget — the caller clears the PID file.
      exec(`powershell.exe -NoProfile -Command "Stop-Process -Id ${pid} -Force"`, () => {});
    } else {
      process.kill(pid, "SIGTERM");
      setTimeout(() => {
        if (isPidAlive(pid)) {
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      }, 2000);
    }
    clearPid();
    return { stopped: true, pid };
  } catch (e) {
    clearPid();
    const err = new Error(`Failed to stop xray: ${e.message}`);
    err.code = "STOP_FAILED";
    throw err;
  }
}

/**
 * Restart: stop the managed process (waiting for it to die), then start again
 * with the same or a new config. Used when switching servers or applying
 * config changes.
 *
 * @param {{ configPath: string }} opts
 */
export async function restartXray({ configPath }) {
  const pid = getManagedPid();
  if (pid) {
    if (process.platform === "win32") {
      await new Promise((resolve) =>
        exec(`powershell.exe -NoProfile -Command "Stop-Process -Id ${pid} -Force"`, () => resolve())
      );
      // Give the OS a moment to release the port.
      await new Promise((r) => setTimeout(r, 500));
    } else {
      try { process.kill(pid, "SIGTERM"); } catch {}
      for (let i = 0; i < 30 && isPidAlive(pid); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (isPidAlive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch {}
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    clearPid();
  }
  return startManagedXray({ configPath });
}

/** Tail the xray runtime log for the dashboard log viewer. */
export function getXrayLogTail(maxLines = 200) {
  try {
    if (!fs.existsSync(LOG_FILE)) return "";
    const content = fs.readFileSync(LOG_FILE, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines).join("\n");
  } catch {
    return "";
  }
}

/**
 * Spawn a TEMPORARY xray instance for one-off config testing (the per-row
 * "Test" button). Returns a handle { pid, kill } so the caller can terminate
 * it WITHOUT touching the shared PID file used by the active service.
 *
 * This isolation is essential: startManagedXray/stopXray share one PID file,
 * so a test that used them would clobber the active proxy's tracking state.
 */
export async function spawnTempXray({ configPath }) {
  if (!isXrayInstalled()) {
    const err = new Error("Xray binary not installed");
    err.code = "NOT_INSTALLED";
    throw err;
  }
  const binary = getXrayBinaryPath();
  const outFd = fs.openSync(LOG_FILE, "a");
  const child = spawn(binary, ["run", "-c", configPath], {
    stdio: ["ignore", outFd, outFd],
    detached: true,
    windowsHide: true,
    env: { ...process.env },
  });
  try { fs.closeSync(outFd); } catch {}
  if (!child.pid) throw new Error("Failed to spawn temp xray");
  child.unref();
  return {
    pid: child.pid,
    kill() {
      try {
        if (process.platform === "win32") {
          exec(`powershell.exe -NoProfile -Command "Stop-Process -Id ${child.pid} -Force"`, () => {});
        } else {
          process.kill(child.pid, "SIGKILL");
        }
      } catch { /* already dead */ }
    },
  };
}

export { LOG_FILE as XRAY_LOG_FILE, PID_FILE as XRAY_PID_FILE };
