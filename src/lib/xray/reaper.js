/**
 * Reap orphaned temp-probe xray processes and config files.
 *
 * Split into its own zero-dependency module (only node built-ins + the
 * dependency-free processGuard) so it can be statically imported at app boot
 * (initializeApp) without pulling in the rest of the xray manager — dynamic
 * import of manager.js from the boot path was unreliable in the Next
 * standalone bundle (chunk side-effects swallowed the call). Static import of
 * this tiny module resolves cleanly.
 *
 * Safe by construction:
 *  - Only touches files matching the temp-probe / filter-api patterns in the
 *    xray dir.
 *  - Only kills processes whose cmdline references those same patterns (or,
 *    for draining retirees, an xray binary) — cmdline-verified on EVERY
 *    platform, Windows included (N4).
 *  - Never touches the main `config.json` or the managed PID.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { DATA_DIR } from "@/lib/dataDir.js";
import { isOurProcess } from "@/lib/processGuard.js";

// Temp artifacts owned by this reaper: per-config probe configs and the
// api-mode filter job's base config (X9).
const TEMP_FILE_PATTERNS = [
  /^config\.json\.model-test-/,        // spawn-per-test probe configs (+ api overlays)
  /^filter-api-\d+-\d+\.json(\.|$)/,   // api-mode filter base configs (+ .ob-* overlays)
];
const TEMP_CMDLINE_RE = /config\.json\.model-test-|filter-api-[0-9]+-[0-9]+/;

// Best-effort persistent log (reaper runs at boot before the app logger is up;
// next-server stdout is often /dev/null in headless deploys). Fail-open.
function reapLog(message, extra = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), message, ...extra });
  try {
    const logDir = path.join(DATA_DIR, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "reaper.log"), line + "\n", { flag: "a" });
  } catch {
    /* logging must never break reaping */
  }
}

/**
 * Reap orphaned temp-probe artifacts. Idempotent, never throws.
 *
 * Scans the real runtime dir (DATA_DIR/xray) and, as a one-release
 * backward-compat sweep, the legacy ~/.9router/xray from older builds (X1).
 *
 * @param {object} [opts]
 * @param {string} [opts.xrayDir] - override the xray config directory (tests)
 * @param {boolean} [opts.skipProcessKill] - skip the host-wide process sweep
 *   (tests: never kill dev-machine processes)
 * @returns {Promise<{ unlinked: number, killed: number, drainedKilled: number }>}
 */
export async function reapOrphanedTempProbes({ xrayDir, skipProcessKill = false } = {}) {
  const dir = xrayDir || getDefaultXrayDir();
  let unlinked = 0;

  // 1. Remove orphaned temp config files (primary dir + legacy sweep).
  let matchCount = 0;
  const matchNames = [];
  for (const scanDir of [dir, ...legacyXrayDirs()]) {
    try {
      const entries = await fs.promises.readdir(scanDir);
      for (const name of entries) {
        if (!TEMP_FILE_PATTERNS.some((re) => re.test(name))) continue;
        matchCount += 1;
        matchNames.push(`${scanDir}${path.sep}${name}`);
        try {
          await fs.promises.unlink(path.join(scanDir, name));
          unlinked += 1;
        } catch (e) {
          reapLog("unlink failed", { dir: scanDir, name, error: e?.message || String(e) });
        }
      }
    } catch (e) {
      reapLog("readdir failed", { dir: scanDir, error: e?.message || String(e) });
    }
  }

  // 2. Kill orphaned temp/filter xray processes, cmdline-verified on every
  // platform (X9/N4). These patterns are only spawned by 9router jobs; at
  // boot, any survivor is by definition an orphan.
  const killed = skipProcessKill ? 0 : killTempXrayProcesses();

  // 3. Kill orphaned DRAINING instances (blue-green retirees). After a Node
  // restart their in-flight requests are gone, so there is nothing left to
  // drain — terminate them and clear the registry. The ACTIVE instance
  // (xray.pid) is never in this file, so it is never touched.
  const drainedKilled = await reapDrainingInstances(dir);

  reapLog("reap complete", {
    dir,
    platform: process.platform,
    matchCount,
    unlinked,
    killed,
    drainedKilled,
    sample: matchNames.slice(0, 5),
  });
  return { unlinked, killed, drainedKilled };
}

/** Kill processes whose cmdline references temp-probe/filter configs. */
function killTempXrayProcesses() {
  let killed = 0;
  try {
    if (process.platform === "win32") {
      // CIM query IS the cmdline match — killed by construction, never a
      // PID-reuse victim (N4).
      const script =
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match ` +
        `'config\\.json\\.model-test-|filter-api-[0-9]+-[0-9]+' } | ` +
        `ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
      spawnSync("powershell.exe", ["-NoProfile", "-NoLogo", "-Command", script], {
        windowsHide: true, stdio: "ignore", timeout: 10000,
      });
      killed += 1; // best-effort count (exact count needs another query)
    } else {
      // pkill -f matches the full cmdline; pattern targets only our temp
      // configs. Exit 1 = no match (the common case), not an error.
      execFileSync("pkill", ["-f", "config\\.json\\.model-test-|filter-api-[0-9]+-[0-9]+"], { stdio: "ignore" });
      killed += 1;
    }
  } catch {
    /* no matches / tool unavailable — fine */
  }
  return killed;
}

/**
 * Terminate xray processes listed in xray.pid.draining and remove the file.
 * Guards against PID reuse by verifying the process cmdline is an xray
 * process before killing — on EVERY platform, including the Windows
 * PowerShell branch (N4).
 */
async function reapDrainingInstances(dir) {
  const file = path.join(dir, "xray.pid.draining");
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(entries)) entries = [];
  } catch {
    return 0; // missing/corrupt file — nothing to reap
  }
  let killed = 0;
  for (const entry of entries) {
    const pid = Number(entry?.pid);
    if (!Number.isFinite(pid)) continue;
    try {
      if (!isOurProcess(pid, "xray")) {
        reapLog("draining pid not verified as xray — skipping (PID reuse guard)", { pid });
        continue;
      }
      if (process.platform === "win32") {
        // windowsHide powershell kill, mirroring process.js killPidWindows
        // without importing it (reaper stays dependency-free).
        spawnSync("powershell.exe", ["-NoProfile", "-NoLogo", "-Command", `Stop-Process -Id ${pid} -Force`], { windowsHide: true, stdio: "ignore", timeout: 5000 });
        killed += 1;
      } else {
        try { process.kill(pid, "SIGKILL"); killed += 1; } catch { /* gone */ }
      }
    } catch (e) {
      reapLog("draining kill failed", { pid, error: e?.message || String(e) });
    }
  }
  try { fs.unlinkSync(file); } catch { /* already gone */ }
  return killed;
}

function getDefaultXrayDir() {
  // The real runtime dir (matches installer.js/process.js, which derive from
  // DATA_DIR — %APPDATA%\9router on Windows, ~/.9router on POSIX only when
  // DATA_DIR is unset). The old hard-coded ~/.9router/xray never matched the
  // actual runtime location on Windows, so nothing was ever reaped (X1).
  return path.join(DATA_DIR, "xray");
}

/** Legacy pre-DATA_DIR xray dir(s), swept once per boot for leftover orphans. */
function legacyXrayDirs() {
  const dirs = [];
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) {
      const legacy = path.join(home, ".9router", "xray");
      if (fs.existsSync(legacy)) dirs.push(legacy);
    }
  } catch { /* best-effort */ }
  return dirs;
}
