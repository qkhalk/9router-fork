# Phase 02 — Managed Subsystems Fixes: v2go/Xray · DS2API · TOTU (X1-X12, N4-N6)

## Context links

- Audit: `plans/reports/2026-09-03-research-feature-roadmap-and-edge-case-audit.md` §A.2 (X1-X12) + Part D N4-N6. All 12 X findings CONFIRMED by red team.
- Integration research: `research/researcher-01-integration-points.md` §1 (settings/scheduler pattern — used by X8/N6).
- Parent plan: [plan.md](plan.md) (release group A).
- **Process rules (AGENTS.md):** GitNexus `impact()` before editing any symbol; `detect_changes()` before commit; report HIGH/CRITICAL risk before proceeding. Re-verify file:line before editing.
- Phase boundary note: the **minimal X6 fix** (advance past dead candidates on failed switch) lives HERE; phase 07 only wires the scheduler. Do not build scheduler machinery in this phase.

## Overview

Fix Windows-first process-lifecycle defects (reaper scans wrong dir; SIGINT handler exits before xray stop resolves; unlocked switchConfig), fail-closed catalog sync (empty subscription must not wipe the catalog), verified binary installs, PID-reuse safety, and make TOTU's configured interval (incl. 0 = manual-only) actually work.

## Key Insights

1. **X1 verified:** `getDefaultXrayDir()` in src/lib/xray/reaper.js:139-144 assumes `~/.9router/xray`, but the real runtime dir is `DATA_DIR/xray` (src/lib/dataDir.js:7-12; `%APPDATA%\9router` on Windows — the fork's primary platform). Orphans are never reaped there. N5 shows the same `~/.9router` hardcode in reaper.js:27, apiFilter.js:35,146-147, managedRotation.js:92-94 — fix all, not just the reaper.
2. **X3 verified:** initializeApp.js:69-70 registers `cleanup` on SIGINT/SIGTERM; the handler `process.exit()`s before the dynamic `import()` of the xray stopper resolves (audit :61-71). Pattern rule (audit pitfall #3): await cleanup, bounded.
3. **X2 is fail-open where fail-closed is required:** HTTP 200 + unparseable body → `markStaleXrayConfigs([])` deactivates every row and (retention 0) deletes the catalog (sync.js:72-87; xrayRepo.js:178-183,213-223). Guard: previous catalog non-empty + parsed 0 ⇒ abort sync, keep old rows, log loudly.
4. **N6 makes X8 real:** `totuAutoFetchIntervalMin || 60` (totuAutoFetch/index.js:218,235) means interval 0 is impossible — `configureTotuAutoFetch` must treat 0 as "stop the timer" (settings route comment already promises this), and boot must call `configureTotuAutoFetch(settings)`, not bare `startTotuAutoFetch()` (initializeApp.js:146, verified).
5. X7+N4: PID files without cmdline verification can kill innocent recycled processes — the POSIX reaper branch verifies cmdline but the Windows draining-kill branch (reaper.js:119-123) doesn't.

## Requirements

- R1 (X1+N5): all managed-subsystem paths derive from `DATA_DIR`; no `~/.9router` literals remain.
- R2 (X9+N4): reaper matches `.test-*` and `filter-api-*` orphans; Windows kills only after cmdline verification (same rule as POSIX branch).
- R3 (X2): sync aborts on empty-parse-over-nonempty-catalog; never deactivates/deletes on a suspect fetch.
- R4 (X3): shutdown awaits managed-stop with a hard 5s bound, then exits; no Ctrl+C leaves a detached xray.
- R5 (X4): `switchConfig` serialized by a promise-chain mutex; overlapping callers queue.
- R6 (X5): xray install verifies the published `.dgst` sha256, extracts to a staging dir, stops the running instance before swapping.
- R7 (X6): a failed auto-rotate switch advances to the next candidate (downgrade the failed one via `updateXrayTestResult`); bounded attempts.
- R8 (X7): `alreadyRunning` and `stop*` verify the PID's cmdline contains the expected binary path before acting (xray + DS2API).
- R9 (X8+N6): boot passes settings to `configureTotuAutoFetch`; interval 0 stops the timer; `|| 60` coercions removed.
- R10 (X10-X12): OTP regex requires 6 digits; apiFilter `waitForPort` only reports ready for a port owned by the live child; credentials.json 0600 on POSIX + TOTU loginToken redacted from DB export.

## Architecture

- No new modules except a tiny shared helper `getManagedProcessDir()`/`dataDirPath(relative)` re-export if dataDir.js doesn't already expose joining (check; KISS: import DATA_DIR directly).
- Shutdown: rewrite `cleanup` in initializeApp.js as async; register `process.on(sig, () => { cleanup().finally(() => process.exit(0)) })` with `Promise.race` 5s timeout; set an `isShuttingDown` latch so double-SIGINT force-exits immediately.
- Mutex: module-level `let switchChain = Promise.resolve()` in manager.js; `switchConfig = (…args) => switchChain = switchChain.then(() => doSwitch(…args), () => doSwitch(…args))` — preserve per-caller errors.
- Installer: download `asset.zip` + `asset.dgst`; verify sha256(dgst) before extract; extract to `<DATA_DIR>/xray/.staging-<ts>`; only on verified extract: stop xray → move staging into place → write `.version`.
- PID verification helper `isOurProcess(pid, expectPathSubstring)`: POSIX `ps -p pid -o command`; Windows `wmic process where processid=<pid> get commandline` (or `tasklist /fi` + PowerShell fallback — pick one available in CI).

## Related code files

| File | Findings |
|---|---|
| src/lib/xray/reaper.js | X1 (:139-144), X9 (:68-78), N4 (:119-123), N5 (:27) |
| src/lib/dataDir.js | X1/N5 source of truth (:7-12) |
| src/lib/xray/sync.js | X2 (:72-87) |
| src/lib/db/repos/xrayRepo.js | X2 (:178-183, :213-223) |
| src/shared/services/initializeApp.js | X3 (:61-71), X8 (:144-148) |
| src/lib/xray/manager.js | X4 (:547-668), X6 (:1386-1399), health-check :1367 |
| src/lib/xray/installer.js | X5 (:124-145, :224-275) |
| src/lib/xray/process.js | X7 (:84-93) |
| src/lib/ds2api/process.js | X7 (:35-43), X12 (:54-65) |
| src/lib/totuAutoFetch/index.js | X8/N6 (:216-224, :218, :235), X12 (:144-157), tick errors :209-210 |
| src/lib/totuAutoFetch/mailtm.js | X10 (:110-135) |
| src/lib/xray/apiFilter.js | X9 (:147, :159-165), X11 (:159-165, :295-307), N5 (:35, :146-147) |
| src/lib/xray/managedRotation.js | N5 (:92-94) |
| src/lib/db/index.js | X12 exportDb redaction (see phase 04 S1 for guard work) |

## Implementation Steps

1. **[N5+X1] Path unification** — grep `~/.9router` and `\.9router` across src/lib/{xray,ds2api,totuAutoFetch}; replace each with `DATA_DIR`-derived paths (reaper.js:27, apiFilter.js:35,146-147, managedRotation.js:92-94, reaper.js:139-144). impact() on `getDefaultXrayDir` + `startForwardServer`-adjacent symbols first.
2. **[X1] reaper.js** — scan `DATA_DIR/xray`; keep backward-compat sweep of legacy dir with a one-time migration/cleanup log (orphans there can still be killed after cmdline check).
3. **[X9+N4] reaper patterns + Windows kill** — add `.test-*` (temp-probe) and `filter-api-*` to the match set (:68-78); Windows draining branch (:119-123) gets the same cmdline verification the POSIX branch has, via the `isOurProcess` helper.
4. **[X2] sync.js** — before `markStaleXrayConfigs`, fetch current count; if previous > 0 && parsedLinks.length === 0 → log error, skip mark/delete entirely, return `{ok:false, reason:"empty-parse"}`. Also treat HTML/body-without-links as empty-parse.
5. **[X3] initializeApp.js shutdown** — async cleanup with 5s `Promise.race` bound + double-signal force-exit (Architecture). Verify the dynamic `import()` of the stopper resolves before exit in a manual Windows test.
6. **[X4] manager.js switchConfig mutex** — promise-chain wrapper (Architecture). Callers (managed rotation, health-check auto-rotate, UI route) unchanged — serialization is inside.
7. **[X5] installer.js** — checksum (.dgst) + staging + stop-first swap (Architecture). Reuse DS2API installer's verified sha256 code path as reference.
8. **[X6] manager.js :1386-1399 auto-rotate** — on candidate switch failure: `await updateXrayTestResult(candidate.id, {ok:false, latency:null/failed})` THEN advance picker to next non-active, healthy candidate; cap attempts at e.g. 5 candidates per rotation; if all fail → leave current active node (do NOT deactivate everything) and log.
9. **[X7] process.js + ds2api/process.js** — `alreadyRunning` and `stopXray`/`stopDS2API` verify cmdline via `isOurProcess`; mismatch ⇒ treat pid file as stale (remove, not "running").
10. **[X8+N6] totuAutoFetch/index.js + initializeApp.js:146** — `configureTotuAutoFetch(settings)`: `interval == null → 60`; `interval <= 0 → clearInterval + inactive`; remove both `|| 60` (:218, :235). Boot: `(await getSettings()) → configureTotuAutoFetch(settings)`. Settings-route PATCH already re-invokes configure (researcher §1 :145-151) — verify it passes 0 through (sanitize maps NaN/<=0 → 0, good).
11. **[X10] mailtm.js:110-135** — OTP regex `\b(\d{6})\b` (digits only); keep fallback order (last match wins per existing logic).
12. **[X11] apiFilter.js :159-165, :295-307** — `waitForPort` succeeds only if (a) child pid alive and (b) port owner is the child (POSIX: `lsof`/`fuser` or connect + cmdline check; Windows: `netstat -ano` PID match). Stale-orphan port ⇒ fail fast with clear error.
13. **[X12] ds2api/process.js :54-65 + totuAutoFetch/index.js :144-157** — `fs.chmodSync(credentials.json, 0o600)` on POSIX after write (no-op guard on win32); exportDb redacts TOTU `loginToken` (coordinate with phase-04 S1 work on the same export path — **file ownership: phase 04 owns src/lib/db/index.js guard logic; this phase only adds the field to the redaction list; land together or sequence phase-04 first; explicit ordering: land with or after phase-04's db/index.js guard changes (release-A sequential execution)**).
14. Run `detect_changes()`; suite + new tests; commit.

## Todo list

- [x] N5 legacy `~/.9router` hardcodes removed (4 sites)
- [x] X1 reaper scans DATA_DIR/xray (+ legacy sweep)
- [x] X9+N4 reaper patterns + Windows cmdline-verified kill
- [x] X2 empty-parse abort guard
- [x] X3 awaited, bounded shutdown + double-SIGINT force exit
- [x] X4 switchConfig promise-chain mutex
- [x] X5 installer checksum/staging/stop-first
- [x] X6 auto-rotate candidate advance + attempt cap
- [x] X7 PID cmdline verification (xray + ds2api)
- [x] X8+N6 configureTotuAutoFetch at boot; interval 0 = off; `|| 60` removed
- [x] X10 OTP digits-only regex
- [x] X11 waitForPort child-owned check
- [x] X12 credentials.json 0600 (POSIX) + loginToken export redaction
- [x] Tests added; suite 0 pass→fail; detect_changes() clean; committed

## Success Criteria

- Unit tests: empty-parse guard (catalog preserved); mutex (two concurrent switchConfig calls serialize — assert via instrumented doSwitch); OTP regex rejects "Verify"; `configureTotuAutoFetch({totuAutoFetchIntervalMin:0})` clears timer; `isOurProcess` mismatch → stale pid handling.
- Manual/CI (Windows): start xray → SIGINT → no orphan `xray.exe` (formalized as CI job in phase 04 quality infra; do the manual check now).
- Full suite green; 0 pass→fail.

## Risk Assessment

| Risk | L×I | Signal it broke | Pre-decided response |
|---|---|---|---|
| Shutdown now takes up to 5s (await stop) — slower Ctrl+C | H×L | Users double-Ctrl+C | Force-exit on second signal already designed in; acceptable. |
| Path unification moves logs/configs on long-running installs | M×M | Files "missing" after upgrade; managedRotation logs empty | Keep legacy path as read-fallback for one release; migration log line. Adjust if reports. |
| Mutex serializes UI switch behind a long rotation | M×M | Dashboard switch feels hung | Return queued position / log wait; timeout UI-side only. |
| Installer staging doubles disk use briefly | L×L | Disk-full errors | Cleanup staging on failure; pre-check free space. |
| X6 cap leaves cluster on a dead node if all candidates dead | M×H | Health check keeps failing (visible once phase 07 ships) | Intended: fail-safe keep-current + alert (phase 07 `xray-rotation-failed`). |

## Security Considerations

- N4/X7 are kill-safety: never `process.kill` without cmdline proof — a wrong kill can murder an unrelated user process (DoS on the host).
- X5 checksum closes a binary-supply-chain hole (mirror compromise) — mandatory before any auto-update flow later.
- X12: export redaction must run before any response is built; test with a fixture DB containing loginToken.

## Next steps

- Phase 07 depends on X6 (step 8) and the health-check surfaces here.
- Alert insertion points added later: tick catch (totuAutoFetch/index.js:209-210), batch errors (:167-185), health-check failure summary (manager.js:1249) — tag with TODO(phase-05) comments only.

## Implementation notes (2026-09-04, executed)

- New shared helpers: `src/lib/processGuard.js` (`isOurProcess` — cmdline verification, CIM on Windows, /proc→ps on POSIX) and `src/lib/serialize.js` (`createSerialized` promise-chain mutex used by `switchConfig`).
- X4 shape: `switchConfig = createSerialized(doSwitchConfig)`; the original function was renamed `doSwitchConfig` (exported). Callers unchanged.
- X1/N5: reaper/apiFilter/managedRotation now derive paths from `DATA_DIR` (logs → `DATA_DIR/logs`); reaper also sweeps the legacy `~/.9router/xray` as a read-fallback; `skipProcessKill` test option added so tests never run the host-wide sweep.
- X9/N4: reaper file patterns cover `config.json.model-test-*`, `filter-api-*` (+ `.ob-*` overlays); Windows kills go through a CIM cmdline-matched query (kill-safe by construction); draining retirees are `isOurProcess`-verified on every platform.
- X2: `syncSubscription` aborts with `{aborted:"empty-parse"}` when 0 links parse over a non-empty catalog; empty-catalog + empty-parse still proceeds.
- X3: async shutdown bounded by 5s `Promise.race`; second SIGINT exits immediately.
- X5: installer verifies the published `.dgst` (any 64-hex token) against the zip's sha256 before extracting to `.staging-<ts>`, stops a running managed instance via dynamic import (avoids the installer↔process module cycle), then swaps.
- X6: health-check auto-rotate tries up to 5 candidates, downgrades each failure via `updateXrayTestResult({ok:false})`, and keeps the current node if all fail. (No direct unit test — manager.js's import graph; covered by the xray-manager-smoke import test + full suite.)
- X7: `getVerifiedManagedPid()` on both process modules; used by start (alreadyRunning), stop, restart. Recycled pid → file removed, reported not-running.
- X8/N6: boot calls `configureTotuAutoFetch(settings)`; interval ≤ 0 stops/never starts the timer (no `|| 60` clamping).
- X10: OTP regex digits-only; the existing totu-autofetch fixture updated from "8e1b0c" to a numeric code to match the red-team-confirmed spec.
- X11: `waitForPortOwnedByChild` — TCP accept + netstat/lsof PID ownership (undeterminable-owner falls back to child-alive); stale orphan holding the port fails fast.
- X12: DS2API credentials re-chmodded 0600 on POSIX on every read/write; `exportDb` redacts TOTU `providerSpecificData.loginToken` (per plan ordering, this lands with phase 04's db/index.js guard work which follows next).
- Verification: 7 new test files (24 tests) green; full-suite diff vs clean tree = 0 new failures (121 pre-existing env failures unchanged). detect_changes(): medium risk, 13 files, all in intended scope.
