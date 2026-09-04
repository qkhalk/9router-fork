# Upstream v0.5.65 vs Plan — Conflict Analysis (2026-09-04)

Range analyzed: 90b52e06 (v0.5.59 merge-base, confirmed) → tag v0.5.65. 97 files, +4225/−552.

## Per-file verdicts (plan-touched ∩ upstream-modified)

| File | Verdict | Detail |
|---|---|---|
| src/sse/handlers/chat.js | **CONFLICT-HIGH** | Upstream (15687d19+ac98dd9d): imports :7-28, `stripModelContextMarker` :47-55, hardcoded 503 in allRateLimited :232-238, `clearAntigravityStrikes` in onRequestSuccess :297-302. Fork already drifted +211 lines (managed-conn block overlaps upstream's onRequestSuccess hunk; import hunks overlap). Plan phases 01/03/05/06/08 add 5 more regions. One guaranteed manual merge either way. |
| open-sse/handlers/search/index.js | CONFLICT-LOW | Upstream: `fetchPublic` import + :103 call. C5 destructure at :155 still lacks callbacks in v0.5.65 → C5 NOT fixed upstream. Auto-merges. |
| src/shared/utils/ssrfGuard.js | **ALREADY-FIXED (S2 fully)** | Upstream b870b5d4 (#3714) = entire S2 design and more: CGNAT 100.64/10, full IPv6 (ULA fc00::/7, fe80::/10, v4-mapped, NAT64, v4-compat), trailing-dot normalize, `assertPublicUrlResolved` (dns.lookup all:true), `fetchPublic` (redirect:manual, per-hop revalidation, 5-hop cap). Wired into search/index.js AND fetch.js. Test ssrf-guard-hardening.test.js. Phase-04 step 3 → verify + port tests (~1h). |
| src/dashboardGuard.js | CONFLICT-LOW | Upstream adds only "/responses" to PUBLIC_PREFIXES :37-40, adjacent-but-disjoint from S1's isCliRequest :41-48. S1 NOT fixed upstream. |
| src/sse/services/antigravityQuota.js | CONFLICT-LOW text / **SEMANTIC-HIGH ph-05/06** | Upstream ac98dd9d adds strikeCounts/strikeBlocks Maps, applyActiveStrikeBlocks wrap, rewrites handleAntigravityQuotaError — a strike-breaker (3×429/60s → 15min block per connectionId+model) overlapping phase-06's generic per-account breaker. Needs reconciliation. |
| open-sse/handlers/chatCore/requestDetail.js | CONFLICT-LOW | Upstream edits only extractUsageFromResponse (:25-50, Responses-shape cached_tokens — fixes phase-09 data prerequisite). apiKey stamping intact (now ~:128). |
| open-sse/services/usage.js | fork-vs-upstream trivial conflict (keep-both USAGE_HANDLERS entries), NO-ISSUE for plan | |
| src/app/api/v1/models/[kind] DELETED / [...model] ADDED | NO-ISSUE | Plan cites parent v1/models/route.js:80 — untouched. |
| ProviderLimits/utils.js | NO-ISSUE | Upstream adds groq case :542; phase-09 doesn't touch it. |
| api/models routes | NO-ISSUE | |

## Findings status vs upstream v0.5.65

- **S2 SSRF: FIXED upstream** (better than plan spec).
- **Phase-09 cached_tokens source: FIXED upstream** (extractUsageFromResponse; panel still ours).
- **Phase-06: PARTIALLY PRE-EMPTED** — antigravity-only strike-breaker; generic per-account breaker still valid, reconcile to avoid double-blocking.
- **NOT fixed upstream (verified in v0.5.65):** C1 (commandcode.js untouched — resolves phase-03 open question: local rewrite), C4 (no NO_FALLBACK_STATUSES), C5, S1, N7, ALL P/X findings (fork files untouched).
- **Fork-feature files 100% untouched upstream** — connectionProxy, proxyRotation, proxyPoolsRepo, xray/*, ds2api/*, totuAutoFetch/*, apiKeysRepo, usageRepo, settingsRepo, schema.js, stream.js, commandcode.js, modality.js, accountFallback, combo, rootCA, initializeApp, tunnel/*.

## Semantic risks post-merge

1. allRateLimited now always 503 (no lastStatus passthrough) — phase-06 skip-path + phase-08 budget 429 must not assume status passthrough.
2. quotaCache can hold synthesized 0% strike-block entries — phase-05 quota-near-limit must distinguish strike blocks from real near-limit reads.
3. "/responses" became a PUBLIC prefix — phase-08 must verify /responses traffic still hits the requireApiKey budget branch.
4. `[1m]` marker strip shifts chat.js line numbers +~10 above :232 — mechanical plan drift.

## Recommendation: MERGE v0.5.65 FIRST, then implement plan

- Hard conflict is chat.js regardless of order; merging first burns it once on today's codebase instead of re-litigating all 5 phases' edits later.
- S2 + phase-09 prerequisites already done upstream — building our versions first guarantees semantic+textual collisions later.
- Post-merge plan drift is small/mechanical (+10 chat.js, +6 requestDetail, +1 search/index, +50 antigravityQuota); plan-first drift is unbounded.
- Post-merge plan amendments: prune phase-04 S2 to verify/port; phase-03 step-1 resolved (no upstream C1 fix → local rewrite); phase-06 + reconcile strikeBlocks (skip/layer for pairs already strike-blocked; show in breaker panel); phase-05 quota-near-limit handles 0% strike entries; phase-08 verifies /responses hits budget branch.
