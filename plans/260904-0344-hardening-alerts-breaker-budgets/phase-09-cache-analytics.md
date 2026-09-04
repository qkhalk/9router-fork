# Phase 09 — Cache Analytics (usage dashboard panel)

## Context links

- Audit: §B.4 (Feature 4, analytics half) — rides v0.6.28 per-key usage rows + v0.5.59 nested `cached_tokens`.
- Integration research: §2 (usageHistory.tokens JSON :99, getUsageStats cachedTokens extraction :413, calculateCost :166 → pricingRepo getPricingForModel :51, getChartData :700, usage API routes + usageDb facade).
- Parent plan: [plan.md](plan.md) (release group C). Depends on: nothing hard (can run parallel with 07/08); shares cost-estimation helpers with phase 08 — coordinate (DRY).
- **Process rules (AGENTS.md):** `impact()` before editing usageRepo symbols / usage page; `detect_changes()` before commit.

## Overview

Dashboard Usage panel: per provider + per model cache hit-rate %, cached tokens, and "saved $X" cost comparison (what those cached tokens would have cost as fresh prompt tokens via pricingRepo). Data from existing usageHistory.tokens JSON — no new API surface (extend existing stats/chart payload consumed by the usage page).

## Key Insights

1. Data already captured: `tokens` JSON column carries `cached_tokens` / `cache_read_input_tokens` (researcher §2, usageRepo.js:99); `getUsageStats` already extracts cachedTokens (:413) — the extraction precedent exists; extend to per provider+model grouping.
2. "Saved $" semantics (define precisely): cached input tokens × prompt-token price for that (provider, model) via pricingRepo. Honest label: "estimated savings vs. uncached prompt cost" — display as estimate, not billed fact (pricing gaps → row shows "n/a" not 0).
3. NO new API surface (user decision): extend the payload of the EXISTING endpoint the usage page already calls (getChartData / stats route — verify which during impl) with a `cache` block; dashboard renders it. No new routes.
4. Hit-rate denominator: requests WITH token data (skip rows with empty/invalid tokens JSON — count them as "unknown", not as misses; show both metrics to avoid lying with ratios).

## Requirements

- R1: usageRepo aggregation `getCacheStats(period)` (or extension of getUsageStats): grouped by provider+model → `{requests, requestsWithCacheData, cachedTokens, promptTokens, hitRatePct = cachedTokens/promptTokens (guarded denom>0), savedUsd}`.
- R2: Cost estimation via pricingRepo (getPricingForModel); missing pricing → `savedUsd:null` + "n/a"; NEVER count cache as negative cost into existing cost columns (read-only analytics).
- R3: Existing usage page: new panel — summary cards (total cached tokens, blended hit-rate, total saved $) + per provider/model table + simple bar/trend using the page's existing chart library (reuse whatever getChartData charting uses — read page first).
- R4: Period selector reuses the page's existing period control; no new controls.
- R5: Performance: aggregation over large usageHistory must not block — reuse the existing stats caching approach if getUsageStats has one (check :378 region); worst case same cost as existing stats call (same table scan shape).

## Architecture

- Server: `getCacheStats(periodDays)` in usageRepo (single pass: SELECT provider, model, promptTokens, tokens for window; parse JSON per row — same parse as :413; group in JS). Extend the usage stats/chart route response with `cache: getCacheStats(...)` — piggyback the existing call the page makes (avoid a second round trip).
- Client: usage page adds `<CachePanel data={stats.cache}/>` — cards + table + trend; i18n keys; loading/empty states ("no cache data in period").
- Shared cost helper: if phase-08 lands a per-token cost estimator, reuse it; else local thin wrapper over pricingRepo (one function, DRY decision at impl time).

## Related code files

| File | Role |
|---|---|
| src/lib/db/repos/usageRepo.js | getCacheStats (new); cachedTokens extraction precedent :413; calculateCost :166 |
| src/lib/db/repos/pricingRepo.js | getPricingForModel :51 |
| src/app/api/usage/ stats/chart route (verify exact route the page calls) | payload extension |
| src/lib/usageDb.js | facade (:4) — pass-through if facaded |
| src/app/(dashboard)/dashboard/usage/page.js (verify path) | panel UI |
| i18n files | keys |

## Implementation Steps

1. **Read the usage page + its API call** — confirm exact route + response shape consumed (impl-time verification; researcher listed src/app/api/usage/ routes generally).
2. **[R1] usageRepo.getCacheStats** — aggregation + guards (denominator 0, missing JSON, null pricing); unit tests with fixture rows (mixed cached/uncached/invalid-JSON/no-pricing).
3. **[R2] cost estimation** — per-row provider+model lookup via pricingRepo (batch where API allows); null on gap; test asserts n/a not 0.
4. **Payload extension** — add `cache` block to the existing route response; impact() on the route handler; backward compatible (additive key).
5. **[R3] CachePanel UI** — cards + table + trend on existing chart lib; i18n; empty/loading states.
6. Run `detect_changes()`; full suite; commit.

## Todo list

- [ ] Usage page + route consumption verified (step 1)
- [ ] getCacheStats + unit tests (step 2)
- [ ] saved-$ estimation with n/a-on-gap (step 3)
- [ ] Route payload extension (additive) w/ impact() (step 4)
- [ ] CachePanel UI + i18n + empty states (step 5)
- [ ] Suite 0 pass→fail; detect_changes() clean; committed

## Success Criteria

- Unit tests: grouping correctness, hit-rate math (incl. zero-denominator), invalid-JSON rows counted as unknown, missing pricing → null, period filtering correct.
- Manual: dashboard shows non-zero hit-rate for any provider with known caching (e.g. cache-heavy models after real traffic); "saved $X" matches hand-computed fixture.
- Additive-only API change (existing consumers unaffected — asserted by existing tests staying green).
- Full suite green; 0 pass→fail.

## Risk Assessment

| Risk | L×I | Signal it broke | Pre-decided response |
|---|---|---|---|
| Per-row JSON parse over long periods = slow dashboard | M×M | Usage page load time up sharply | Same scan shape as existing stats; if slow → aggregate into usageDaily-style rollup at write time (bigger change — stop-and-replan with user) or clamp default period. |
| Saved-$ misleading when pricing stale/missing | M×L | Users dispute savings numbers | n/a rendering + "estimate" label; link to pricing source in tooltip. Adjust = hide column entirely if pricing coverage <50% of rows (pre-decided heuristic). |
| Payload extension breaks a strict client | L×L | Dashboard JS errors on old cached bundle | Additive key only; page renders panel only when `cache` present. |

## Security Considerations

- No new endpoint = no new unauthenticated surface; cache stats inherit existing usage-route auth.
- No key material in panel (fingerprints only if per-key view added later — out of scope).

## Next steps

- Release group C (07+08+09) completes → tag (plan.md: actual v0.6.37) + CHANGELOG `## Features` entries.
- Optional follow-up (out of scope): per-API-key cache breakdown (joins phase-08 budgets page), cost-trend alerts.
