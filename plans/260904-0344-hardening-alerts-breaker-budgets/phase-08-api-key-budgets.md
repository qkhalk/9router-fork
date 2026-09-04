# Phase 08 — Per-API-Key Budgets

## Context links

- Audit: §B.4 (Feature 4) + §Feature-design research (LiteLLM max_budget/soft_budget/budget_duration; bugs to avoid: #16185 webhook-stops-after-first-trigger → edge-triggered + per-window re-arm; #27735 stale-spend → read fresh spend at enforcement).
- Integration research: §2 (usageHistory schema :109, per-key since v0.6.28; usageRepo helpers), §3 (in-handler auth point chat.js:74-98; apiKeys schema.js:78 has NO budget columns; closest 429 shape `unavailableResponse` chat.js ~:280).
- Parent plan: [plan.md](plan.md) (release group C). Depends on: **phase-05** (budget-threshold alert event).
- **Process rules (AGENTS.md):** `impact()` before editing chat.js auth block / apiKeysRepo / usageRepo symbols; `detect_changes()` before commit.

## Overview

Per-API-key budgets: unit = USD-estimated OR tokens (per-key choice), window = daily OR monthly (per-key choice), soft alert at threshold (default 80%) + optional hard block (429 + Retry-After + `X-9Router-Budget` warning header from 80%). Spend aggregated fresh from usageHistory at enforcement. Dashboard per-key budget editor on the existing API-keys page.

## Key Insights

1. **STEP 0 RESOLVED (2026-09-04 red-team verification; keep as a quick verify at phase start, NOT a gate):** apiKey IS stamped on all usage paths — chain verified: chat.js:312 (apiKey into handleChatCore) → chatCore.js:62/:471 (sharedCtx) → saveUsageStats with apiKey at streamingHandler.js:139 / sseToJsonHandler.js:207+307 / nonStreamingHandler.js:321 → requestDetail.js:118 → usageRepo.js:301/:317; embeddings.js:140 too. Failed requests (0 tokens) are dropped (requestDetail.js:103) — acceptable. User decision: fix stamping everywhere (n/a — already complete).
2. **Enforcement point (verified):** in-handler, after `isValidApiKey(apiKey)` (chat.js:89), before model resolution — same in-handler pattern as existing auth (no middleware exists). Fresh spend read inside this check (LiteLLM #27735 lesson).
3. **Schema is trivial to extend (researcher):** TABLES auto-migration ALTERs new columns (used by phase-01 `failStreak` too). usageHistory already has `apiKey TEXT` (per-key since v0.6.28). `idx_uh_apikey_ts` auto-applies idempotently via syncSchemaFromTables (migrate.js:104-107) — no manual migration. Monthly windows use live indexed SUM (correct choice; usageDaily per-key blobs exist but monthly live-SUM is simpler and indexed).
4. **Edge-trigger design (LiteLLM #16185 lesson):** per-key in-memory Map `alertedWindows: Map<apiKey, {windowKey, alerted:boolean}>`; crossing fires once per window; new window (dateKey/monthKey) re-arms automatically. Alert fires when spend crosses threshold — detectable at enforcement (pre-request) AND post-recording; KISS v1: check at enforcement (pre-request) covers the crossing because every new request passes through it; post-recording check adds precision but needs a hook in the usage-recording path from step 0 — decide after scout.
5. **429 shape exists:** `unavailableResponse(status, msg, retryAfter, retryAfterHuman)` (chat.js ~:280, verified import :17) — hard block reuses it + adds `X-9Router-Budget` header (present from 80% as warning, informational; on block it says "exceeded").
6. **Red-team caveats (2026-09-04):** (i) budget enforcement sits inside the `if (settings.requireApiKey)` branch (chat.js:84-94) — budgets are inert unless requireApiKey is ON; document in UI next to budget fields. (ii) USD budgets read SUM(cost) where cost comes from pricingRepo — cost=0 rows when no pricing is configured for the model, so USD budgets silently under-count; the per-key UI must warn when a key's spend is dominated by unpriced models; token budgets are exact. (iii) spend SELECT must use the raw apiKey string (not fingerprint). (iv) **post-v0.5.65 verification (upstream 98579f98):** "/responses" became a PUBLIC dashboard-guard prefix — at phase start VERIFY /v1/responses traffic still flows through the chat handler's requireApiKey/budget branch (chat.js:84-94); if /responses bypasses that branch, budget enforcement must also hook the bypassing path.

## Requirements

- R1: apiKeys columns: `budgetType TEXT DEFAULT 'off'` (`off|usd|tokens`), `budgetLimit REAL DEFAULT 0`, `budgetWindow TEXT DEFAULT 'daily'` (`daily|monthly`), `softThresholdPct INTEGER DEFAULT 80`, `hardBlock INTEGER DEFAULT 0`. Auto-migration-safe for existing DBs (all defaults = current behavior).
- R2: Fresh-spend helper `getSpendForKey(apiKey, windowStart)` in usageRepo: `SUM(cost)` and `SUM(promptTokens+completionTokens)` (+ cached tokens counted? NO — cache reads are upstream-served; count prompt+completion as billed approximation; document) from usageHistory `WHERE apiKey=? AND timestamp>=?` (the `?` binds the RAW apiKey string, not a fingerprint — Key Insight 6(iii)). Add index `idx_uh_apikey_ts ON usageHistory(apiKey, timestamp)` (auto-applies idempotently via syncSchemaFromTables, migrate.js:104-107 — no manual migration).
- R3: Enforcement in chat.js auth block: budgetType off → skip (zero added queries for unbudgeted keys — hot-path guard). Budgeted: read config (with key row — fetched anyway? `isValidApiKey` does its own SELECT; refactor to one SELECT returning the row — impact() first) + fresh spend; soft: crossing threshold → emitAlert(budget-threshold) once per window; hard: `hardBlock && spend >= budgetLimit` → 429 + Retry-After (window end) + `X-9Router-Budget: limit-exceeded`; from 80% even when soft-only → `X-9Router-Budget: nearing-limit` informational header. Caveat (Key Insight 6(i)): enforcement sits inside the `if (settings.requireApiKey)` branch (chat.js:84-94) — budgets are inert unless requireApiKey is ON; document in UI next to budget fields.
- R4: Editor UI on existing API-keys dashboard page (per-key: type, limit, window, threshold %, hard-block toggle); server-side validation (limit > 0 when type != off; pct 1-100). UI must warn when a key's spend is dominated by unpriced models (USD budgets silently under-count — cost=0 rows when pricingRepo has no pricing for the model; token budgets are exact; Key Insight 6(ii)).
- R5: budget-threshold alert event (payload: key fingerprint/name — never the key, spend, limit, pct, window end).
- R6: Timezone: windows computed in server-local time (document; no tz UI v1); daily = local midnight, monthly = 1st local midnight.

## Architecture

```
chat.js auth block (after isValidApiKey):
  key row (single SELECT: key, isActive, budgetType, budgetLimit, budgetWindow, softThresholdPct, hardBlock, keyHash legacy fields)
  if budgetType !== 'off':
    windowStart = startOfWindow(budgetWindow)          // pure helper, unit-tested
    spend = await getSpendForKey(apiKey, windowStart)  // fresh read (no cache)
    pct = spend.usd / budgetLimit (or tokens ratio)
    if hardBlock && spend >= limit → 429 + Retry-After(windowEnd) + header
    else if pct >= softThresholdPct && !alertedThisWindow(key, windowKey) → emitAlert + mark alerted
    if pct >= 0.8 → set X-9Router-Budget header
```
- `alertedThisWindow`: Map in new tiny module src/sse/services/keyBudgets.js (Map idiom; window-key = `${apiKeyFingerprint}:${windowKey}`) — also holds `startOfWindow` + unit math; keeps chat.js thin.
- usageRepo: `getSpendForKey` returns `{usd, tokens}`.
- API-keys page: budget columns in existing key table + edit dialog (copy patterns from that page's existing edit UI — read page first).

## Related code files

| File | Role |
|---|---|
| src/lib/db/schema.js | apiKeys :78 columns; usageHistory :109 + new index |
| src/lib/db/repos/apiKeysRepo.js | row-returning validate refactor (:70 validateApiKey; :41-44 lookup) |
| src/lib/db/repos/usageRepo.js | getSpendForKey (new); recording path traced in step 0 |
| src/sse/handlers/chat.js | enforcement :74-98; unavailableResponse reuse :280 |
| src/sse/services/keyBudgets.js (new) | window math + alerted-windows Map |
| src/lib/alerts/index.js | budget-threshold event (phase-05) |
| src/app/(dashboard)/dashboard/api-keys/page.js (verify exact path) | editor UI |
| src/sse/handlers/embeddings.js | :140 — the one direct saveRequestUsage caller; step-0 trace start |

## Implementation Steps

1. **[SCOUT — RESOLVED; quick verify only, not a gate]** Trace chat usage recording — chain verified (Key Insight 1): apiKey IS stamped on all usage paths (chat.js:312 → chatCore.js:62/:471 → saveUsageStats at streamingHandler.js:139 / sseToJsonHandler.js:207+307 / nonStreamingHandler.js:321 → requestDetail.js:118 → usageRepo.js:301/:317; embeddings.js:140). At phase start, re-verify the listed lines still hold (grep); no gap list or user decision needed — failed requests (0 tokens) dropped at requestDetail.js:103 is acceptable. Also re-verify the /responses routing caveat (Key Insight 6(iv)): /v1/responses must still hit this handler's requireApiKey/budget branch (chat.js:84-94) post-v0.5.65.
2. **Schema + repo** — add columns (R1) + index; refactor `validateApiKey` → `getApiKeyRow(key)` returning full row (keep `isValidApiKey` as thin wrapper — impact() for callers); `getSpendForKey` (R2). Unit tests incl. migration on a v0.6.33-style snapshot DB.
3. **keyBudgets.js** — startOfWindow (daily/monthly, local tz), alerted-window Map, threshold math; unit tests for month boundaries/year rollover.
4. **chat.js enforcement** — wire R3 flow into auth block; off-keys zero-cost (single boolean check); 429 shape via unavailableResponse + extra header (extend it or build response inline following its pattern); tests: unbudgeted key unchanged; soft crossing alerts once per window (two requests → one alert); hard block 429 + Retry-After = window end; header present ≥80%.
5. **UI** — budget editor on API-keys page (R4): columns + dialog + validation; i18n keys.
6. **Alert** — budget-threshold emit (payload per R5) — event type already registered in phase-05.
7. Run `detect_changes()`; full suite; commit.

## Todo list

- [ ] Step-0 scout RESOLVED (apiKey verified stamped on all usage paths — chain in Key Insight 1); quick re-verify at phase start (step 1)
- [ ] Schema columns + idx_uh_apikey_ts + snapshot-DB migration test (step 2)
- [ ] getApiKeyRow refactor w/ impact() (step 2)
- [ ] getSpendForKey + tests (step 2)
- [ ] keyBudgets.js window/alerted logic + tests (step 3)
- [ ] chat.js enforcement + tests (step 4)
- [ ] API-keys page editor + i18n (step 5)
- [ ] budget-threshold alert wiring (step 6)
- [ ] Suite 0 pass→fail; detect_changes() clean; committed

## Success Criteria

- Tests: migration (old DB → columns defaulted, keys still valid); spend aggregation sums correct rows only (window-filtered); edge-trigger fires once per window and re-arms next window (fake timers over midnight/month boundary); hard block returns 429 with correct Retry-After + header; unbudgeted keys add zero queries (assert SELECT count).
- Manual: set $0.01 budget on a test key → alert arrives (phase-05 channel) at 80%, 429 at limit; dashboard editor persists.
- Full suite green; 0 pass→fail.

## Risk Assessment

| Risk | L×I | Signal it broke | Pre-decided response |
|---|---|---|---|
| Fresh-spend SELECT per request adds latency to EVERY budgeted-key request | M×M | p95 latency up on budgeted keys | Single indexed SELECT (apiKey,timestamp) ≈ sub-ms at expected row counts; if hot → 5s-TTL spend cache (accepting #27735-style staleness ≤5s, documented trade). |
| Usage paths that don't stamp apiKey make budgets silently under-count | M×H | Budget page spend ≠ usage page totals per key | That's exactly scout step 1; if gaps found → fix stamping in-phase (preferred) or document endpoint scope + dashboard warning. |
| Hard block locks out a key mid-coding session (angry user) | M×M | Support reports; X-9Router-Budget 429s | By design (opt-in hardBlock, default 0); Retry-After + header explain; soft-only default keeps v1 safe. |
| Monthly window + timezone edge (server UTC vs user local) | L×L | Budget resets at "wrong" hour | Documented server-local; if reported → add per-install tz setting (adjust). |
| validateApiKey refactor breaks CLI/middleware callers | L×H | Auth failures | Thin-wrapper keeps signature; impact() enumerates callers; suite covers. |

## Security Considerations

- Alert payloads and dashboard show key FINGERPRINT/name only — never the key (mirrors usageRepo maskApiKey/fingerprint helpers :25,:40).
- Budget config mutation = dashboard-auth route; validate all numeric inputs server-side (no NaN/<=0 limits, pct clamp).
- Spend endpoint reuse: no new API surface beyond existing apiKeys CRUD (columns ride existing PUT).

## Next steps

- Phase 09 (cache analytics) shares usageRepo pricing helpers — coordinate to avoid duplicate cost-estimation logic (DRY: one `estimateCost` path).
- Later (out of scope): per-key rollover budgets, team-level budgets, budget UI graphs.
