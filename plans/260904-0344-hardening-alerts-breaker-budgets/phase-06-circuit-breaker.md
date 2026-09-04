# Phase 06 — Circuit Breaker (new module src/sse/services/circuitBreaker.js)

## Context links

- Audit: §B.2 (Feature 2) + §Feature-design research (closed/open/half-open canonical semantics; probe = next REAL request, not synthetic canary; half-open admits exactly ONE).
- Integration research: §4 (getProviderCredentials internals, markAccountUnavailable :247, clearAccountError :306, chat.js fallback-loop lines, antigravityQuota.js Map idiom :12-16).
- Parent plan: [plan.md](plan.md) (release group B, second phase). Depends on: **phase-05** (emitAlert + EVENT_TYPES). Coordinates with: phase-03 N7 (first-byte success signal).
- **Process rules (AGENTS.md):** `impact()` before editing chat.js/auth.js symbols; `detect_changes()` before commit; HIGH/CRITICAL risk reported before proceeding.

## Overview

Per-account (connectionId) circuit breaker as a wrapper layer ON TOP of the existing modelLock — modelLock internals untouched. Module Map registry (copy antigravityQuota.js pattern), closed/open/half-open with half-open admitting exactly ONE real user request as a passive probe, exponential backoff on repeated open (60s ×2, cap 10 min), and dashboard breaker-state panel. Feeds `breaker-open` / `breaker-recovered` events to the alert system.

## Key Insights

1. **User-decided design (FINAL):** wrapper at the chat.js call site — breaker checked BEFORE attempting an account; `markAccountUnavailable` path feeds failures; `clearAccountError`/`onRequestSuccess` feed successes; modelLock internals unchanged. Probe failure falls through tiers normally (user request never sacrificed to the breaker).
2. **Feed points (verified lines):** chat.js fallback loop :268+; success `clearAccountError` :340; failure `markAccountUnavailable(...)` :515; N7 (phase-03) moves `onRequestSuccess` to first forwarded byte — breaker `recordSuccess` rides the same signal so a headers-then-die upstream doesn't close a breaker.
3. **Canonical semantics (researched):** closed → N failures in window → open (fail fast) → cooldown → half-open admits exactly ONE trial request; success closes, failure re-opens with longer cooldown. For LLM gateways the probe is the next real request (no synthetic canary = no wasted tokens, probes the exact failing path). Recovering account must not be flooded: half-open admits 1, not all.
4. Scope is per-ACCOUNT (connectionId), not per (provider, account, model) — user decision. modelLock keeps handling per-model scoping underneath; the breaker answers one question: "is this account worth attempting at all right now?"
5. Map idiom (antigravityQuota.js:12-16): module-level `const breakers = new Map()` + inflight-probe dedup — established in-repo pattern, no DB writes, restart = clean slate (acceptable: breakers re-learn within one window; document).
6. SKIP the breaker entirely for noauth free-provider credentials — `credentials.connectionId` is undefined there (auth.js:61-75); keying a breaker on undefined would make ALL public providers share one breaker and poison each other.

## Requirements

- R1: `checkBreaker(connectionId)` → `{allowed:true, probe?:boolean}` | `{allowed:false, retryAfterMs}` — O(1), no await on hot path.
- R2: `recordFailure(connectionId)` — closes→open at N=5 failures within 60s window (sliding); half-open probe failure → open with backoff (60s ×2 per consecutive open, cap 600s).
- R3: `recordSuccess(connectionId)` — any state → closed, resets backoff; riding N7 first-byte signal.
- R4: chat.js integration: after `getProviderCredentials` (:270) returns credentials, if breaker denies that connectionId → `excludeConnectionIds.add(credentials.connectionId)` AND `minRetryAfterMs = Math.min(minRetryAfterMs, gate.retryAfterMs)` BEFORE `continue` (a bare `continue` re-picks the same account forever — the chat.js while-loop's only advance mechanism is the exclusion set, :519). If ALL candidates breaker-denied → the loop calls `unavailableResponse(status, msg, iso, human)` itself with `new Date(Date.now()+minRetryAfterMs).toISOString()` — existing allRateLimited retryAfter data is NOT available (modelLock-invisible; error.js:112-117 expects ISO, not ms; `formatRetryAfter` importable from accountFallback.js:90, no cycle). Skip the breaker entirely for noauth free-provider credentials (`credentials.connectionId` undefined, auth.js:61-75).
- R5: Half-open: exactly one concurrent real request admitted as passive probe; concurrent requests during probe are denied (fall through tiers — not queued, not harmed).
- R6: `getBreakerStates()` for dashboard (list: connectionId → provider name, state, failures, openUntil, consecutiveOpens).
- R7: emits `breaker-open` (dedupKey connectionId; include provider) and `breaker-recovered` on close-from-open, via phase-05 emitAlert.
- R8: modelLock behavior byte-identical when breaker module disabled (config off) — dead-simple kill switch `breakerEnabled` setting (default true; defensive).

## Architecture

```
src/sse/services/circuitBreaker.js
  const breakers = new Map();        // connectionId → {state, failures[], openedAt, openUntil, consecutiveOpens, probeInFlight}
  checkBreaker(id) / recordFailure(id) / recordSuccess(id) / getBreakerStates() / resetBreaker(id)
```
- Failure window: keep timestamps of last 5 failures; count only those within 60s.
- checkBreaker on open: if `now >= openUntil` → transition to half-open, mark `probeInFlight=true`, return `{allowed:true, probe:true}`; single synchronous transition (no await before flag set — same lesson as phase-01 P8).
- recordFailure while probe → open, `consecutiveOpens++`, `openUntil = now + min(60000 * 2^(consecutiveOpens-1), 600000)`.
- recordSuccess → closed, `consecutiveOpens=0`, if previous state was open/half-open → emit breaker-recovered.
- chat.js wrapper (call-site): after credentials obtained and before attempt: `const gate = checkBreaker(credentials.connectionId); if (!gate.allowed) { excludeConnectionIds.add(credentials.connectionId); minRetryAfterMs = Math.min(minRetryAfterMs, gate.retryAfterMs); log; continue; }` — the exclusion-set add is LOAD-BEARING: a bare `continue` re-picks the same account forever; the chat.js while-loop's only advance mechanism is the exclusion set (:519). Skip the gate entirely when `credentials.connectionId` is undefined (noauth — see Key Insight 6). When the loop ends with all candidates breaker-denied: existing allRateLimited retryAfter data is NOT available (modelLock-invisible) — the loop calls `unavailableResponse(status, msg, iso, human)` itself with `new Date(Date.now()+minRetryAfterMs).toISOString()` (error.js:112-117 expects ISO, not ms; `formatRetryAfter` importable from accountFallback.js:90, no cycle). On attempt failure path (:515 region) call `recordFailure(connectionId)`; on success (:340 clearAccountError site + N7 callback) call `recordSuccess(connectionId)`.
- Dashboard: extend existing dashboard (small panel — e.g. section on the connections/quota-adjacent page) listing getBreakerStates(); no new API surface beyond one GET route if none fits (check existing connections GET response first — prefer piggybacking).
- Settings: `breakerEnabled` (DEFAULT_SETTINGS, default true), `breakerFailureThreshold:5`, `breakerWindowSec:60`, `breakerBaseCooldownSec:60` — admin-tunable, no UI v1 (settings keys only) unless modal cost is trivial. `breakerEnabled` must be read OUTSIDE the per-iteration path (hoist to loop entry or cache with TTL) — chat.js fetches settings per-iteration at :302, after the gate point.

## Related code files

| File | Role |
|---|---|
| src/sse/services/circuitBreaker.js (new) | module |
| src/sse/handlers/chat.js | integration :268-287 (skip path), :340 (success), :515 (failure) |
| src/sse/services/antigravityQuota.js | Map-idiom reference :12-16 |
| src/lib/alerts/index.js | emitAlert + EVENT_TYPES (phase-05) |
| src/lib/db/repos/settingsRepo.js | breaker* DEFAULT_SETTINGS keys |
| dashboard connections/usage page (locate exact page during impl) | breaker panel |
| open-sse/handlers/chatCore/streamingHandler.js | N7 first-byte success callback (phase-03 dependency) |

## Implementation Steps

1. **Module** — circuitBreaker.js per Architecture (pure, no imports beyond alerts emit via dynamic import; clock injectable for tests). Unit tests first (state machine table: closed→open→half-open→closed; backoff 60/120/240/480/600/600; single-probe admission under concurrency).
2. **Settings keys** — `breakerEnabled/breakerFailureThreshold/breakerWindowSec/breakerBaseCooldownSec` in DEFAULT_SETTINGS (mergeWithDefaults auto-fills).
3. **chat.js wiring** — impact() on the chat handler + getProviderCredentials call site. Skip logic (R4) with continue-loop semantics; failure feed at :515 region; success feed at :340 + N7 callback (guard: only once per request). Respect `breakerEnabled=false` → zero behavior change.
4. **Alerts** — emit breaker-open on open transition, breaker-recovered on close-from-open (EVENT_TYPES from phase-05).
5. **Dashboard panel** — small state table (connection, provider, state badge, failures, opens again in Xs); poll or piggyback existing connections GET; manual "reset breaker" button (calls resetBreaker) — minimal.
6. **Tests at integration level** — simulated provider failing N times (mock executor): assert attempt-skip after open (request count to provider stops), single probe after cooldown, recovery on success; assert fall-through: probe failure still serves user via next account (no 503 caused by breaker alone).
7. Run `detect_changes()`; full suite; commit.

## Todo list

- [ ] circuitBreaker.js state machine + unit tests (step 1)
- [ ] DEFAULT_SETTINGS keys (step 2)
- [ ] chat.js wrapper wiring (skip/failure/success feeds) w/ impact() (step 3)
- [ ] breaker-open / breaker-recovered alerts (step 4)
- [ ] Dashboard state panel + reset button (step 5)
- [ ] Integration tests incl. probe-fallback-not-harmed (step 6)
- [ ] Suite 0 pass→fail; detect_changes() clean; committed

## Success Criteria

- Unit tests: all state transitions incl. backoff sequence and cap; exactly-one-probe under 10 concurrent checkBreakers; disabled kill-switch = pass-through.
- Integration: after 5 failures in 60s, provider receives 0 further attempts until cooldown; one probe admitted post-cooldown; failed probe → backoff doubled AND user request served by fallback account; recovered account closes breaker + alert emitted once (dedup).
- Full suite green; 0 pass→fail.

## Risk Assessment

| Risk | L×I | Signal it broke | Pre-decided response |
|---|---|---|---|
| Breaker + modelLock double-locking starves all accounts (503 loops) | M×H | 503s with breakers all open + modelLocks active; worse than baseline | Skip-path continues fallback loop (never 503 while other accounts allowed); kill switch `breakerEnabled=false`. If interaction bugs → disable by default for one release, ship module dark. |
| Per-account granularity too coarse (one bad model poisons whole account) | M×M | Breaker opens on account whose modelLock would have scoped to one model | Intentional (user decision); modelLock still scopes underneath once an attempt IS made. If field reports show model-specific poisoning → stop-and-replan to per-(account,model) keys (mechanical change: key = `${connectionId}:${model}`). |
| In-memory registry forgets state on restart → post-restart flood to dead account | L×L | One window of failed requests after restart | Accepted (documented); breakers re-learn within 60s window. |
| checkBreaker added latency on hot path | L×L | p95 latency | O(1) Map read, no await; test asserts <0.1ms. |
| Alert spam on flapping account (open/recover cycles) | M×M | breaker-open/recovered pairs spamming channel | Phase-05 dedup window (10 min) dampens; if still noisy → only alert on Nth consecutive open (adjust, pre-decided). |

## Security Considerations

- Breaker states expose account health — dashboard panel behind existing auth (no new data to unauthenticated surfaces; require-login route stays boolean).
- No secrets in alert payloads (connection name/provider only, never tokens).
- resetBreaker endpoint must be auth-guarded like sibling dashboard mutations.

## Next steps

- Release group B (05+06) completes → tag (plan.md: actual v0.6.36) + CHANGELOG `## Features` entries.
- Phase 07 can start once phase-05 lands (independent of this phase).
