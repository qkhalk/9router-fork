---
title: "9router Hardening, Alerts, Circuit Breaker & Budgets"
description: "3-release program: fix all audit findings (P/X/C/S + N), then add alert system, per-account circuit breaker, v2go health scheduler, per-API-key budgets, cache analytics"
status: completed
priority: P1
effort: 128h
branch: master
tags: [hardening, security, alerts, circuit-breaker, budgets, v2go, cache-analytics]
created: 2026-09-04
---

# 9router Hardening, Alerts, Circuit Breaker & Budgets

Source audit: `plans/reports/2026-09-03-research-feature-roadmap-and-edge-case-audit.md` (45 findings P1-P12/X1-X12/C1-C10/S1-S10, red-team verdicts 41 CONFIRMED / 4 PARTIAL, plus 12 new N1-N12).
Integration research: `research/researcher-01-integration-points.md` (settings pattern, usage schema, apiKey enforcement point, modelLock internals, alert insertion points).
Upstream prerequisite (user decision 2026-09-04): merge upstream v0.5.65 BEFORE implementing phase 01 — see reports/upstream-0.5.65-conflict-analysis.md. Plan line numbers below were verified against pre-merge master; post-merge drift is small/mechanical (chat.js +~10 lines above :232, requestDetail.js +6, search/index.js +1, antigravityQuota.js +~50 after :17) — re-verify anchors at each phase start (already mandated by Global rules).

## Release mapping (user decision, FINAL)

| Release group | Tag (shifted 2026-09-04: v0.6.35 taken by the upstream-merge release 26b99473) | Phases | Content |
|---|---|---|---|
| A — Robustness | **v0.6.36** | 01-04 | All bug fixes + hardening (P/X/C/S/N) + CI/fuzz quality infra — S2 SSRF arrives upstream-fixed via the v0.5.65 merge (verify/port only, phase-04) |
| B — Alerts + Breaker | **v0.6.37** | 05-06 | Alert system + per-account circuit breaker |
| C — Scheduler + Budgets | **v0.6.38** | 07-09 | v2go health scheduler + per-key budgets + cache analytics |

> **Tag history:** v0.6.34 shipped (2026-09-04, "OpenCode Free reliability release") during research; user confirmed v0.6.35/36/37 for this plan; then v0.6.35 was consumed by the upstream v0.5.65 merge + donate release (26b99473, 2026-09-04) — program tags shift to v0.6.36/37/38. P9 disposition confirmed: REMOVE dead `_excludedProxyEntryIds` code (KISS).

## Phases

| # | Phase | Status | Release | Effort | Scope |
|---|---|---|---|---|---|
| 01 | [Proxy pool fixes](phase-01-proxy-pool-fixes.md) | done | A | M/L 14h | P1-P12, N1-N3 — strictProxy fail-closed, delta-writes, deactivation streak, ordering, dispatcher cache |
| 02 | [Managed subsystems fixes](phase-02-managed-subsystems-fixes.md) | done | A | L 16h | X1-X12, N4-N6 — reaper DATA_DIR, shutdown await, switchConfig mutex, installer checksum, TOTU interval |
| 03 | [Core path fixes](phase-03-core-path-fixes.md) | pending | A | L 16h | C1-C10, N7-N9 — CommandCode peek rewrite, body clone per attempt, fallback no-fallback set, stream finalize |
| 04 | [Security fixes](phase-04-security-fixes.md) | pending | A | L 14h | S1-S10, N10-N12 — CLI-token auth, SSRF verify/port (upstream-fixed), key hashing at rest, tunnel default flip; + Windows CI + fuzz tests |
| 05 | [Alert system](phase-05-alert-system.md) | pending | B | L 20h | New `src/lib/alerts/` — TG/Discord/webhook senders, queue+limits, dedup, settings UI |
| 06 | [Circuit breaker](phase-06-circuit-breaker.md) | pending | B | L 16h | New `src/sse/services/circuitBreaker.js` — wrapper over modelLock, half-open single probe, dashboard panel |
| 07 | [V2Go health scheduler](phase-07-v2go-health-scheduler.md) | pending | C | S/M 6h | Wire `xrayHealthCheckIntervalMin` boot scheduler + re-arm + alerts |
| 08 | [API-key budgets](phase-08-api-key-budgets.md) | pending | C | L 18h | apiKeys schema columns, fresh-spend enforcement, 429 + headers, per-key UI; scout gate PRE-RESOLVED (apiKey verified stamped on all usage paths) |
| 09 | [Cache analytics](phase-09-cache-analytics.md) | pending | C | M 8h | Usage panel: cache hit-rate, tokens saved, $ saved; extends existing stats payload |

## Dependency graph

```
01 (proxy) ──┐
02 (xray) ───┼──> release A tag ──> 05 (alerts) ──> 06 (breaker emits alert events)
03 (core) ───┤                              │
04 (security)┘                              └──> 07 (scheduler emits xray alerts)
                                                   08 (budgets emit budget-threshold alerts)
                                                   09 (independent; only needs usageRepo)
```
- 06, 07, 08 all depend on 05 (emitAlert API) but not on each other.
- 07 depends on 02's X6 minimal fix (candidate advance) for meaningful auto-rotation.
- 08 step 0 scout task PRE-RESOLVED by plan red-team (2026-09-04): apiKey IS stamped on all usage paths (chain verified: chat.js:312 → chatCore sharedCtx → streamingHandler/sseToJsonHandler/nonStreamingHandler → requestDetail.js:118 → usageRepo.js:301/:317; embeddings.js:140).
- 09 has no blockers; can run parallel with 05-08.
- Release-A ordering constraints (red-team): execute phases sequentially 01→02→03→04 (no parallel branches): 01+03 co-edit chat.js/auth.js (disjoint regions) and 02-X12 must land with/after 04's db/index.js guard; 04's fuzz fixtures reuse phase-03's stream-parser fixtures.

## Global rules (apply to every phase)

- **AGENTS.md process:** run GitNexus `impact({target, direction:"upstream"})` before editing any symbol; `detect_changes()` before every commit; report HIGH/CRITICAL risk to user before proceeding. Never rename via find-and-replace.
- **Test baseline:** 2,442 tests green (v0.6.33 changelog). Every phase must add tests and keep the full suite at 0 pass→fail.
- **Releases:** tag after each phase-group (A/B/C) completes; CHANGELOG.md entries in existing style (`# vX.Y.Z (date)`, prose intro, `## Fixes` / `## Features` with bold-titled bullets — see current head of CHANGELOG.md).
- **Findings are static-read:** audit file:line verified 2026-09-03/04 against master; re-verify each site before editing (GitNexus `context()` or grep).
- All work on `master` per user instruction; commit per phase (or per finding-cluster within a phase) after `detect_changes()` passes.

## Backwards compatibility strategy (program-level)

- Settings: all new keys go in `DEFAULT_SETTINGS`; `mergeWithDefaults` auto-fills for existing DBs (settingsRepo.js:129-131) — no migration needed except S6 explicit-key check (phase 04).
- Schema: `TABLES` auto-migration ALTERs new columns (researcher §Surprises) — used by phase 01 (`failStreak`) and phase 08 (budget columns).
- One risky migration: S7 apiKeys hash-at-rest (phase 04) — plaintext fallback during transition; flagged there.

## Open Questions (remaining)

1. ~~C1 upstream cherry-pick: check upstream vibecoder11200 for a CommandCode peek fix before local rewrite (audit Unresolved Q2) — decide at phase-03 start.~~ **RESOLVED (2026-09-04):** verified against upstream tag v0.5.65 — upstream does NOT touch `open-sse/executors/commandcode.js` (v0.5.59→v0.5.65) → no cherry-pick exists; local rewrite confirmed. (Also resolved: tags=v0.6.35/36/37 ✓, S7=HMAC per-install now ✓, P9=remove dead code ✓.)

## Validation Summary

**Validated:** 2026-09-04
**Questions asked:** 4 (validation interview) + 12 earlier design rounds

### Confirmed Decisions
- S7 apiKeys hash-at-rest: HMAC-SHA256 with per-install secret, done in phase-04 (v0.6.35), with backfill+fallback+revert runbook as planned
- Circuit breaker granularity: per-account (connectionId) — modelLock keeps per-model scoping underneath
- Git workflow: direct commits to master per phase/finding-cluster, detect_changes() before every commit (matches current repo habit)
- Phase-08 scout gate contingency: if chat path doesn't stamp apiKey into usage rows → fix stamping everywhere (root-cause), then build budgets on complete data
- (Earlier) 3 phased releases; strictProxy try-all→fall-through→never-direct + N=3 deactivation streak; breaker wrapper on modelLock with passive half-open probe; budgets soft+hard per key; alerts 3 channels + event toggles + 10-min dedup; tunnel default flip preserving saved values; cache analytics dashboard panel per provider+model

### Action Items
- [x] Phase-03 start: check upstream for C1 CommandCode peek fix (cherry-pick vs rewrite) — RESOLVED 2026-09-04: verified v0.5.65 does NOT touch commandcode.js → local rewrite
- [x] Phase-04 start: confirm HMAC secret mechanism shares getOrCreateInstallSecret with CLI-token/sudo-key work (single mechanism, no duplication) — RESOLVED 2026-09-04: phase-04 shipped one getOrCreateInstallSecret (src/lib/auth/installSecret.js) consumed by CLI-token, sudo AES key, and apiKeys HMAC

### Plan Red-Team (2026-09-04) — 9 amendments applied
2 verifier agents (cross-phase consistency + integration soundness vs real code). Verdict: PLAN-CONSISTENT; 57/57 findings slotted, no duplications. Critical catches: phase-06 breaker skip MUST `excludeConnectionIds.add(connectionId)` (bare continue = infinite re-pick in chat.js:269 loop) + local minRetryAfterMs → unavailableResponse(ISO); phase-01 — auth.js has NO internal candidate loop (:46-68 = noauth branch), exhausted marker flows up to chat.js which excludes+continues; missed strictProxy caller `quotaAutoPing.js:198` (live origin-IP leak, now in scope); xray-node-down emit single-owner (phase-05, dropped from 07); streamingHandler path corrected to open-sse/handlers/chatCore/; phase-08 scout pre-resolved + caveats (budgets inert unless requireApiKey on; USD under-counts unpriced models — UI warning); release-A phases run sequentially 01→04; S7 marked DECIDED (HMAC per-install).
