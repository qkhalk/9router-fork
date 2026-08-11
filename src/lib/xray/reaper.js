/**
 * Reap orphaned temp-probe xray processes and config files.
 *
 * Split into its own zero-dependency module (only node built-ins) so it can be
 * statically imported at app boot (initializeApp) without pulling in the rest
 * of the xray manager — dynamic import of manager.js from the boot path was
 * unreliable in the Next standalone bundle (chunk side-effects swallowed the
 * call). Static import of this tiny module resolves cleanly.
 *
 * Safe by construction:
 *  - Only touches files matching `config.json.model-test-*` in the xray dir.
 *  - Only kills xray processes whose cmdline references that same pattern.
 *  - Never touches the main `config.json` or the managed PID.
 *  - POSIX-only process kill (Windows skips it; orphaned temp xray is rare
 *    there and tracked by PID differently).
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Best-effort persistent log (reaper runs at boot before the app logger is up;
// next-server stdout is often /dev/null in headless deploys). Fail-open.
function reapLog(message, extra = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), message, ...extra });
  try {
    const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
    const logDir = path.join(home, ".9router", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "reaper.log"), line + "\n", { flag: "a" });
  } catch {
    /* logging must never break reaping */
  }
}

/**
 * Reap orphaned temp-probe artifacts. Idempotent, never throws.
 *
 * @param {object} [opts]
 * @param {string} [opts.xrayDir] - override the xray config directory (tests)
 * @returns {Promise<{ unlinked: number, killed: number }>}
 */
export async function reapOrphanedTempProbes({ xrayDir } = {}) {
  const dir = xrayDir || getDefaultXrayDir();
  let unlinked = 0;

  // 1. Remove orphaned temp config files.
  let matchCount = 0;
  const matchNames = [];
  try {
    const entries = await fs.promises.readdir(dir);
    for (const name of entries) {
      if (/^config\.json\.model-test-/.test(name)) {
        matchCount += 1;
        matchNames.push(name);
        try {
          await fs.promises.unlink(path.join(dir, name));
          unlinked += 1;
        } catch (e) {
          reapLog("unlink failed", { name, error: e?.message || String(e) });
        }
      }
    }
  } catch (e) {
    reapLog("readdir failed", { dir, home: process.env.HOME, error: e?.message || String(e) });
  }

  // 2. Kill orphaned temp xray processes (POSIX only).
  let killed = 0;
  if (process.platform !== "win32") {
    try {
      // pkill -f matches the full cmdline; pattern targets only model-test configs.
      execFileSync("pkill", ["-f", "config\\.json\\.model-test-"], { stdio: "ignore" });
      killed += 1; // pkill returns 0 on match; exit 1 means no match (not an error)
    } catch {
      /* exit code 1 = no match, which is the common case — not an error */
    }
  }

  reapLog("reap complete", {
    dir,
    home: process.env.HOME,
    platform: process.platform,
    matchCount,
    unlinked,
    killed,
    sample: matchNames.slice(0, 5),
  });
  return { unlinked, killed };
}

function getDefaultXrayDir() {
  // Mirror installer.getXrayConfigPath() without importing installer.js (keep
  // this module dependency-free). The xray config dir is ~/.9router/xray.
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return path.join(home, ".9router", "xray");
}
