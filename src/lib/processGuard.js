/**
 * Kill-safety helpers: verify a PID actually belongs to one of OUR managed
 * processes before signaling it. A recycled PID that now points at an
 * unrelated user process must never be killed (X7/N4).
 *
 * Zero runtime dependencies (node built-ins only) so the reaper can import it
 * without breaking its dependency-free boot constraint.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * Does `pid` belong to us — i.e. does its command line contain the expected
 * binary-path substring? Returns false when the process is gone, the probing
 * tool fails, or the cmdline doesn't match (fail-safe: never act on a PID we
 * cannot prove is ours).
 *
 * @param {number} pid
 * @param {string} expectSubstring - substring of the expected command line
 *   (e.g. "xray", "ds2api", or the full binary path).
 * @returns {boolean}
 */
export function isOurProcess(pid, expectSubstring) {
  const target = Number(pid);
  if (!Number.isFinite(target) || target <= 0 || target === process.pid) return false;

  let cmdline = "";
  try {
    if (process.platform === "win32") {
      // /proc is unavailable on Windows; query CIM. wmic is deprecated on
      // modern Windows, so go straight to PowerShell.
      cmdline = execFileSync(
        "powershell.exe",
        [
          "-NoProfile", "-NonInteractive", "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${target}").CommandLine`,
        ],
        { windowsHide: true, timeout: 5000, encoding: "utf8" }
      ) || "";
    } else {
      // Fast path: /proc (Linux; sometimes present under Git Bash on macOS no).
      try {
        cmdline = fs.readFileSync(`/proc/${target}/cmdline`, "utf8");
      } catch {
        cmdline = execFileSync(
          "ps", ["-p", String(target), "-o", "command="],
          { timeout: 5000, encoding: "utf8" }
        ) || "";
      }
    }
  } catch {
    // Process gone or the probing tool failed — cannot prove ownership.
    return false;
  }
  return typeof expectSubstring === "string"
    ? cmdline.includes(expectSubstring)
    : cmdline.trim().length > 0;
}
