# Phase 01 — Proxy Pool / Rotation Fixes (P1-P12, N1-N3)

## Context links

- Audit: `plans/reports/2026-09-03-research-feature-roadmap-and-edge-case-audit.md` §A.1 (P1-P12) + Part D new issues N1-N3 + Partials (P12).
- Integration research: `research/researcher-01-integration-points.md` §4 (account selection), §5 (proxy exhaustion points).
- Parent plan: [plan.md](plan.md) (release group A).
- **Process rules (AGENTS.md):** MUST run GitNexus `impact()` (upstream) before editing any symbol listed below; `detect_changes()` before commit; report HIGH/CRITICAL risk to user before proceeding. All findings are static-read — re-verify line numbers before editing.

## Overview

Fix the proxy-pool subsystem's systemic fail-open behavior. Centerpiece: **strictProxy becomes fail-closed** — when a strict pool yields no usable entry, the request must NEVER go direct; it falls through to the next account/combo tier and only 503s when everything is exhausted. Plus: transactional delta-writes to kill the lost-update family (P2/N2), deactivation streaks instead of single-test flips (P1/N1), and eight smaller hardening fixes.

## Key Insights

1. **Verified control flow (why P1 happens):** `resolveConnectionProxyConfig` (src/lib/network/connectionProxy.js) returns `source:"none"` (:217) when pool deactivated/group all-cooling/deleted/entry empty-URL, and `source:"error"` (:231) on DB failure **with `strictProxy:false` hard-coded at :240** (N3). Callers stamp `connectionProxyUrl:""` into credentials (src/sse/services/auth.js:60-68), chatCore.js:349 only uses a proxy when `connectionProxyUrl` is non-empty, so the fetch goes DIRECT — `strictProxy` is only consulted inside proxyFetch when a proxyUrl EXISTS and the fetch throws (open-sse/utils/proxyFetch.js:341-352).
2. **User-decided P1 semantics (FINAL):** try all group entries (respecting cooldowns/exclusions) → if none usable, treat as a failed *account attempt* and fall through to next account/combo tier → never direct. Deactivation requires N=3 consecutive failed tests, never 1.
3. Lost-update family (P2, N2): every writer persists a whole `entries` snapshot read before an await; the correct in-repo pattern already exists (`markProxyEntryCooldown` in proxyPoolsRepo.js — read-modify-write inside one transaction). Copy it.
4. All `resolveConnectionProxyConfig` call sites (verified by grep, 10 total — chat-side plus 9 peripheral): auth.js:60, auth.js:201, src/sse/services/antigravityQuota.js:57, src/shared/services/quotaAutoPing.js:198, src/app/api/providers/[id]/models/route.js:397, src/app/api/providers/[id]/test/testUtils.js:888, src/app/api/usage/[connectionId]/route.js:149, src/app/api/usage/[connectionId]/codex-reset-credits/route.js:66, src/app/api/v1/models/route.js:80. Every one must handle the new exhausted signal (fail the operation, not fall back to direct). Red-team addition — quotaAutoPing.js:198: its `buildProxyOptions` hard-codes `strictProxy:false` and drops `.source` (:96-104), so on strict-exhausted it direct-pings provider auth/quota endpoints from the origin IP; fix: skip the ping when `source==="exhausted" && strictProxy` (ping is auxiliary; skipping is graceful).
5. Managed v2go pool hard-codes `strictProxy:true` (manager.js:398) and noauth rotation auto-picks it — a deliberately stopped xray makes ALL noauth providers on that strategy 503 (intended, but surface a dashboard hint on the pool page).

## Requirements

- R1 (P1+N3): When the bound pool has `strictProxy:true` and resolution yields no usable entry — or resolution itself errored — the system must not issue a direct request on behalf of that account. Signal exhaustion to the account-fallback loop; 503 only when all tiers exhausted.
- R2 (P1+N1): Pool test route must not set `isActive:false` on a single failed test or on "no entries to test"; require 3 consecutive failures.
- R3 (P2+N2): No writer persists a stale whole-`entries` snapshot; all entry mutations are transactional delta-writes.
- R4 (P3): Pool DELETE must refuse (or cascade-warn) when `settings.providerStrategies[*].proxyPoolId` still references the pool.
- R5 (P4-P12): empty-URL entries unselectable; dispatcher cache closes evicted agents; import dedup; stable rotation ordering; single-flight rotation; proxyxoay cooldown-clear + null-guard; `cooldownUntil` normalized to epoch-ms on write.

## Architecture

- `resolveConnectionProxyConfig` return contract gains two explicit failure modes: `{source:"exhausted", strictProxy:true}` (no usable entry in a strict pool) and `{source:"error", strictProxy:true}` (DB failure under strict pool — N3 flips the hard-coded `false` at connectionProxy.js:240 to propagate the pool's real flag). Non-strict pools keep today's graceful `{source:"none"}` behavior (direct allowed).
- Account-fallback integration point: NOT a loop inside auth.js — `getProviderCredentials` has no internal loop; :46-68 is the noauth single-pick branch. `resolveConnectionProxyConfig` returns the exhausted/fail marker; in the AUTHED path chat.js's while-loop adds the connectionId to `excludeConnectionIds` and continues to the next account (never direct); in the NOAUTH branch auth.js returns the existing `{allRateLimited:true, ...}`-shape result (no fallback candidate exists there) so chat.js:273-287 produces `unavailableResponse`. In chat.js's 429/5xx proxy-group rotation block (:422-496), group-exhausted under strictProxy must mark THIS attempt failed and continue the account loop (log line :495-496 already describes the fall-through; make it strict-aware).
- Deactivation streak: new column `failStreak INTEGER DEFAULT 0` on `proxyPools` (schema.js TABLES auto-migration). Test route increments on failure, resets on success; auto-deactivate only at streak >= 3. Manual UI toggle unchanged (explicit user action always wins).
- Delta-write repo helpers (new, in proxyPoolsRepo.js, `markProxyEntryCooldown` pattern): `stampProxyEntryUsed(poolId, entryId)`, `setEntryCooldown(poolId, entryId, untilMs)`, `rotateGroupCursor(poolId, nextIndex)`.

## Related code files

| File | Role |
|---|---|
| src/lib/network/connectionProxy.js | resolve: group :101-151, none :217, error :224-242 (strictProxy:false @240) |
| src/sse/services/auth.js | getProviderCredentials :28; pool pick + resolve :46-68 (noauth single-pick branch); markAccountUnavailable :247 |
| src/sse/handlers/chat.js | fallback loop :268+; allRateLimited :273-287; 429/5xx group rotation :422-496 |
| src/lib/db/repos/proxyPoolsRepo.js | updateProxyPool wholesale :102-113; ordering :50; cooldownUntil :147-150 |
| src/app/api/proxy-pools/[id]/route.js | DELETE :273-284 |
| src/app/api/proxy-pools/[id]/test/route.js | group branch :56-76 (N1), stale write :92-114 (N2), isActive flip :113,161 |
| src/sse/services/antigravityQuota.js | caller :57 |
| src/shared/services/quotaAutoPing.js | buildProxyOptions :96-104 (strictProxy:false hard-coded, drops `.source`); ping site :198 — skip ping on strict-exhausted |
| src/lib/network/proxyRotation.js | entry pick :148-155 (P4), rr counter :175-179 (P7) |
| open-sse/utils/proxyFetch.js | strictProxy throw :341-352 (keep); dispatcher cache :216-237 (P5) |
| src/lib/xray/managedRotation.js | doRotate await gap :366-393 (P8) |
| src/lib/proxy/providers/proxyxoayManager.js | rotateKey :181-196 (P10), startForwardServer :290 (P11) |
| src/app/(dashboard)/dashboard/proxy-pools/page.js | import dedup :597-607, 644-668 (P6) |
| src/lib/db/schema.js | proxyPools TABLES entry — add `failStreak` |

## Implementation Steps

1. **[P1+N3] connectionProxy.js `resolveConnectionProxyConfig`** — impact() first (HIGH expected: 9 callers). When pool.strictProxy && no usable entry after iterating group entries (respecting cooldowns + exclusions): return `{source:"exhausted", strictProxy:true}`. In the catch path (:224-242): propagate `strictProxy: pool?.strictProxy === true` instead of `:240`'s literal false. Keep non-strict behavior identical.
2. **[P1] auth.js `getProviderCredentials` + chat.js loop (fail-closed marker consumption)** — auth.js has NO internal candidate loop; :46-68 is the noauth single-pick branch. Correct integration shape: `resolveConnectionProxyConfig` returns the exhausted/fail marker; in the AUTHED path, chat.js's while-loop adds the connectionId to `excludeConnectionIds` and continues to the next account (never direct); in the NOAUTH branch, auth.js returns an allRateLimited-shape result (no fallback candidate exists there). Never set `connectionProxyUrl:""` credentials for a strict pool.
3. **[P1] chat.js group-rotation block (:422-496)** — when strict group exhausts mid-request (all entries on cooldown after 429s), stop retrying entries, log, continue outer account loop (never direct). Coordinate with step 2's skip logic so account isn't double-tried.
4. **[P1+N1] test route `src/app/api/proxy-pools/[id]/test/route.js`** — replace `isActive: result.ok` (:113, :161) with `failStreak` increment/reset; auto-deactivate only at streak >= 3. Group branch (:56-76): grant the v2go exemption the single-pool branch has; "no entries to test" → 400-style error response, NOT `isActive:false`.
5. **[P2+N2] proxyPoolsRepo.js** — add transactional delta-writes (`stampProxyEntryUsed`, `setEntryCooldown`, `rotateGroupCursor`; copy `markProxyEntryCooldown`). Rewrite connectionProxy.js:116-124 pick path and test route :92-114 to use them; `updateProxyPool` (:102-113) stops replacing `entries` when only metadata changed (split metadata vs entries paths).
6. **[P3] DELETE route (:273-284)** — before delete, read settings `providerStrategies`; if any provider binds this poolId, return 409 listing providers (option body `{force:true}` to unbind then delete).
7. **[P4] proxyRotation.js:148-155** — filter `!entry.proxyUrl` entries out of candidate set; if all empty → exhausted result (feeds step 1).
8. **[P5] proxyFetch.js:216-237** — on dispatcher-cache eviction, `await agent.close()` (fire-and-forget with error log if sync context required); guard double-creation with per-key inflight promise. Env-proxy policy (strict-fail path :341-352): when `strictProxy && !connectionProxyUrl`, an env-var proxy (proxyFetch.js:314) must be IGNORED (throw), never used as a substitute.
9. **[P6] dashboard/proxy-pools/page.js** — group import dedup by `host:port (+ username)`; unify single-pool dedup key to `${url}|||${noProxy}` (:644-668 vs :597-607).
10. **[P7] proxyRotation.js:175-179 + proxyPoolsRepo.js:50** — order pools by `createdAt, id` (stable), not `updatedAt`; make rrCounter keyed per pool id (module Map) so bumps don't fight the sort.
11. **[P8] managedRotation.js:366-393** — set a synchronous `rotating` boolean flag BEFORE the first await in the cooldown-bypass path; clear in finally; concurrent callers return the in-flight result.
12. **[P9] connectionProxy.js:113-115** — remove dead `_excludedProxyEntryIds` plumbing OR wire per-request exclusion into the pick (choose during impact(); KISS default: remove, add exclusion param only if step 1-3 work needs it). Log cooldown-persist failures instead of `.catch(()=>{})`.
13. **[P10] proxyxoayManager.js:181-196** — on successful `rotateKey`, clear the entry's runtime `cooldownUntil` (delta-write from step 5) so the fresh IP is immediately selectable.
14. **[P11] proxyxoayManager.js:290** — null-guard pool row (and entry) before `startForwardServer` use; log and skip if deleted mid-registration.
15. **[P12] proxyPoolsRepo.js:147-150** — normalize on every write: `typeof v === "string" ? Date.parse(v) : Number(v)`; reject NaN (treat as no cooldown + warn).
16. Run `detect_changes()`; full test suite + new tests (below); commit.

## Todo list

- [ ] P1+N3 connectionProxy strict-exhausted/error signals (steps 1)
- [ ] P1 auth.js candidate-skip + chat.js strict-aware rotation (steps 2-3)
- [ ] P1+N1 test-route failStreak=3 + v2go exemption + no-entries guard (step 4)
- [ ] P2+N2 delta-write repo helpers + both lost-update writers (step 5)
- [ ] P3 DELETE providerStrategies 409 (step 6)
- [ ] P4 empty-URL filter (step 7)
- [ ] P5 dispatcher close + inflight guard (step 8)
- [ ] P6 import dedup unification (step 9)
- [ ] P7 stable ordering + per-pool rr counter (step 10)
- [ ] P8 synchronous single-flight flag (step 11)
- [ ] P9 dead-code removal decision + logged persists (step 12)
- [ ] P10 rotateKey clears cooldown (step 13)
- [ ] P11 null-guard (step 14)
- [ ] P12 cooldownUntil normalization (step 15)
- [ ] Tests added; suite 0 pass→fail; detect_changes() clean; committed

## Success Criteria

- New unit tests: (a) strict pool + deactivated/all-cooldown/deleted/empty-URL/DB-throw each yields NO direct fetch and falls through accounts (mock proxyFetch to fail test if called without dispatcher); (b) 3-streak deactivation, reset on success, no-entries never deactivates; (c) concurrent `setEntryCooldown` + `stampProxyEntryUsed` don't lose writes (fake-timer/serialized tx test); (d) DELETE with binding → 409; (e) rotation order deterministic across 100 picks.
- Behavior verified: strict pool outage ends in 503 with retry-after, never a request without proxy dispatcher.
- Full suite green (baseline 2,442 + new); 0 pass→fail.

## Risk Assessment

| Risk | L×I | Signal it broke | Pre-decided response |
|---|---|---|---|
| Strict fall-through turns silent-direct "working" setups into 503 storms (strict pools with chronically dead entries) | M×H | Spike in 503/`proxy-pool-exhausted` logs after deploy; user reports | Expected consequence of the contract; emit alert (phase 05 event `proxy-pool-exhausted`) + dashboard banner. If noise unbearable → stop-and-replan gating (e.g. strict-only-on-explicit opt-in per pool) with user. |
| auth.js loop change alters account selection for non-strict users | L×H | Regression in existing account-fallback tests; changed pick order | Keep non-strict path byte-identical; test diff on selection traces. Adjust = revert skip logic to strict-only condition. |
| failStreak column migration on large pool tables | L×M | Boot errors on old DBs | TABLES auto-migration handles ALTER (verified pattern); test on copy of a v0.6.33 DB before merge. |
| Delta-write rewrite breaks v2go managedRotation interplay (P8 + P2 same file) | M×M | Rotation tests / manual blue-green fails | Sequence P8 before P2 in same PR; detect_changes() scope check. |
| Dispatcher close() on evicted agent aborts in-flight requests using it | M×M | Random ECONNRESET after cache churn | Only close agents with refcount 0 (track active requests per agent); if complex → defer close to process-idle timer. |

## Security Considerations

- P1 is itself the security fix (origin-IP leak). Fail-closed must hold on EVERY path: none/error/exhausted/deleted/empty-URL — each gets a test (R1).
- Step 6's 409 body must not leak provider API keys — list provider names/ids only.
- No new logging of proxy credentials; existing masking stays.

## Next steps

- Phase 02 (managed subsystems) is independent — can start in parallel with different files.
- The `proxy-pool-exhausted` / `strictproxy-violation` signals added in steps 1-3 become phase-05 alert insertion points (tag call sites with TODO(comments) referencing phase-05).
- Constraint for phase-05 wiring: emitAlert calls inside `resolveConnectionProxyConfig` run inside auth.js's `selectionMutex` (auth.js:34-40 wraps :201) — emit must be strictly fire-and-forget (never awaited; sync dedup check only).
