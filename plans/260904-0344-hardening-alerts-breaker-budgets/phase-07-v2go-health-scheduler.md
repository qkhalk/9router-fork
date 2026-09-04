# Phase 07 — v2go Health-Check Scheduler (wire xrayHealthCheckIntervalMin)

## Context links

- Audit: §B.3 (Feature 3) + X6 (minimal fix lands in phase-02; this phase wires the scheduler).
- Integration research: §1 (settings → scheduler pattern end-to-end: DEFAULT_SETTINGS :87, sanitize :94-101, PATCH side-effect :145-151, configureTotuAutoFetch pattern totuAutoFetch/index.js:206-235, boot initializeApp.js:144-148).
- Parent plan: [plan.md](plan.md) (release group C, first phase). Depends on: **phase-05** (emitAlert), **phase-02** (X6 candidate advance — auto-rotation is meaningful only with it).
- **Process rules (AGENTS.md):** `impact()` before editing initializeApp.js / manager.js symbols; `detect_changes()` before commit.

## Overview

Cheapest win in the program: the dashboard setting `xrayHealthCheckIntervalMin` (settingsRepo.js:87, default 10, verified) currently maps to nothing. Wire it: boot-started scheduler (copy configureTotuAutoFetch pattern), re-arm on settings PATCH, rotation-failure → `xray-rotation-failed` alert (the ONLY event this phase emits; `xray-node-down` is owned and emitted by phase-05 inside manager.js runHealthCheck — not by this scheduler). Interval 0 = off (mirror phase-02 N6 semantics).

## Key Insights

1. All the pieces exist: `runHealthCheck` (manager.js:1367) + auto-rotate on failed probe (:1386-1399, made correct by phase-02 X6) + the settings key + the PATCH side-effect idiom. This is wiring, not building.
2. Boot must read settings and call `configureXrayHealthCheck(settings)` — NOT a bare `startXrayHealthCheck()` (that's exactly bug X8's shape in the sibling TOTU subsystem; don't reproduce it).
3. Re-arm semantics: PATCH of `xrayHealthCheckIntervalMin` → clear + reset interval. Sanitize mirrors TOTU: NaN/<0 → 0; `Math.max(5, floor)` for positives (0 = manual-only — align with the settings-route convention set in phase-02 N6).
4. Scheduler runs only when xray/v2go is the active egress mode — guard tick to no-op (cheap check, no throw) when no xray is configured, so non-v2go installs pay ~nothing.

## Requirements

- R1: `configureXrayHealthCheck(settings)` in new src/lib/xray/healthScheduler.js — interval from `settings.xrayHealthCheckIntervalMin`; `>0` → setInterval tick (error-catching, never unhandled-reject); `0/undefined-with-default-off?` — NOTE: DEFAULT is 10 (settingsRepo :87), so undefined → mergeWithDefaults supplies 10; explicit 0 → timer cleared, manual-only.
- R2: Boot wiring in initializeApp.js next to TOTU configure call (:144-148 region) — pass full settings; guard behind xray-configured check.
- R3: Settings PATCH side-effect (route :145-151 block): dynamic import + reconfigure on every settings save that includes the key (KISS: reconfigure on every save — idempotent).
- R4: Tick behavior: run health check (health failures already emit `xray-node-down` via phase-05's emit inside manager.js runHealthCheck — NOT this scheduler); auto-rotation attempted (existing runHealthCheck/rotate path); rotation failure → emitAlert(xray-rotation-failed, {reason}) — the only event this phase emits.
- R5: Overlap guard: skip tick if a previous check still in flight (single-flight boolean set synchronously — phase-01 P8 lesson).
- R6: Scheduler state introspectable: exported `getXrayHealthSchedulerState()` (running, intervalMs, lastRunAt, lastResult) for dashboard/debug log — minimal, no UI v1.

## Architecture

```
src/lib/xray/healthScheduler.js
  let timer = null; let running = false; let lastRunAt = null;
  configureXrayHealthCheck(settings)  — clear+set per interval; 0 → clear only
  tick() — single-flight; dynamic-import manager runHealthCheck; map result → alerts; catch-all log
  getXrayHealthSchedulerState()
```
- Copy structure of src/lib/totuAutoFetch/index.js scheduler portion (:206-235) incl. its error-catching tick (:209-210 pattern — but log + alert instead of swallow).
- No DB access beyond settings passed in; no new settings keys (key exists).

## Related code files

| File | Role |
|---|---|
| src/lib/xray/healthScheduler.js (new) | scheduler |
| src/shared/services/initializeApp.js | boot wiring (:144-148 region) |
| src/app/api/settings/route.js | PATCH side-effect (:145-151 block) |
| src/lib/xray/manager.js | runHealthCheck :1367; probe results :1178-1192; summary :1249; auto-rotate :1386-1399 |
| src/lib/alerts/index.js | emitAlert (phase-05) |
| src/lib/db/repos/settingsRepo.js | key + defaults (:87) |

## Implementation Steps

1. **healthScheduler.js** — module per Architecture; unit tests with fake timers + injected fake runHealthCheck (success / failure / throws / long-running overlap).
2. **Boot wiring** — initializeApp.js: after settings load, `configureXrayHealthCheck(settings)` when xray configured; impact() on the boot path symbol.
3. **PATCH re-arm** — settings route side-effect block: add dynamic import + configure (mirror TOTU line exactly).
4. **Alerts** — `xray-rotation-failed` ONLY, from rotation outcome (same result object). xray-node-down is NOT emitted here: phase-05 owns that emit inside manager.js runHealthCheck (:1249/:1367) — this scheduler stays wiring-only for node-down.
5. **Integration test** — fake xray (stubbed runHealthCheck via module mock, or a fake "xray binary" script if the existing testkit has one — check tests/ for xray fixtures first): interval fires → check runs → failure handled (node-down alert comes from phase-05's manager.js emit — not asserted here) → rotation attempted (spied) → rotation failure → xray-rotation-failed alert emitted (spied) → next tick after backoff; settings PATCH to 0 stops timer.
6. Run `detect_changes()`; full suite; commit.

## Todo list

- [ ] healthScheduler.js + unit tests (step 1)
- [ ] Boot wiring w/ impact() (step 2)
- [ ] PATCH re-arm (step 3)
- [ ] xray-rotation-failed alert wiring ONLY (step 4; xray-node-down owned by phase-05 in manager.js)
- [ ] Fake-xray integration test (step 5)
- [ ] Suite 0 pass→fail; detect_changes() clean; committed

## Success Criteria

- Unit: interval honored (fake timers), 0 clears timer, in-flight overlap skips, tick errors never reject.
- Integration: full loop (fire → check → fail → rotate-fail → xray-rotation-failed alert) with spies (xray-node-down NOT emitted by the scheduler — owned by phase-05 in manager.js); PATCH 0 mid-run stops future ticks.
- Manual: dashboard interval change reflected in `getXrayHealthSchedulerState()` (log line).
- Full suite green; 0 pass→fail.

## Risk Assessment

| Risk | L×I | Signal it broke | Pre-decided response |
|---|---|---|---|
| Scheduler + manual UI check overlap → concurrent runHealthCheck | M×M | Duplicate rotation attempts in logs | Single-flight is scheduler-local; UI path remains manual (rare, user-initiated). If races observed → share the in-flight flag via module export from manager.js. |
| Health check on every tick wakes idle systems / spams alerts on chronically bad node | M×M | Repeated xray-node-down per interval | Phase-05 dedup window dampens (emit lives in manager.js runHealthCheck, phase-05-owned); if noisy → emit only on state TRANSITION (down→up), pre-decided adjustment. |
| Boot wiring regresses startup for non-xray installs | L×H | Boot failures on installs without xray | Configured-guard + try/catch around configure; integration test boots without xray config. |

## Security Considerations

- Scheduler triggers rotation = process management — runs only under authenticated dashboard context (it's server-internal, no new route).
- Alert payloads: node identifiers/errors only; never include subscription URLs or credentials.

## Next steps

- Phase 08 (budgets) and 09 (cache analytics) proceed independently.
- If DS2API health checks are wanted later, generalize this module — out of scope now.
