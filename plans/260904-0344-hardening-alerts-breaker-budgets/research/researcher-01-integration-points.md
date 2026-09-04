# Researcher Report — Feature Integration Points (2026-09-04)

Source: researcher agent, 13 tool calls, verified against source.

## 1. Settings pattern end-to-end
- Storage: single JSON blob. Table `settings` (`id INTEGER PK, data TEXT`), src/lib/db/schema.js:28. settingsRepo.js:
  - `DEFAULT_SETTINGS` (~lines 6-100); `totuAutoFetchIntervalMin: 60` at :84.
  - `mergeWithDefaults(raw)` — new keys auto-filled for existing DBs (no migration needed; add to DEFAULTS).
  - `getSettings()` :147; `updateSettings(updates)` — atomic read-merge-write in `db.transaction`, `INSERT ... ON CONFLICT(id) DO UPDATE`.
- Route: src/app/api/settings/route.js PATCH — sanitize pattern :94-101 (`totuAutoFetchIntervalMin`: NaN/<=0 → 0, else `Math.max(5, Math.floor(raw))`); post-save side-effect wiring :145-151: dynamic `import("@/lib/totuAutoFetch").then(({configureTotuAutoFetch}) => configureTotuAutoFetch(settings))` + `.catch` warn.
- Scheduler module: src/lib/totuAutoFetch/index.js — reads `settings.totuAutoFetchIntervalMin ?? 60` (:206), `configureTotuAutoFetch(settings)` ~:235; tick errors caught :209-210.
- UI pattern: NO central settings page — per-feature modal/card. `src/app/(dashboard)/dashboard/providers/[id]/TotuAutoFetchModal.js` (:36,:55 reads/writes `totuAutoFetchIntervalMin`, PATCHes `/api/settings`); xray toggles in `dashboard/xray/page.js`. Copy TotuAutoFetchModal for new alert/budget UI.

## 2. Usage data
- Schema: `usageHistory` (schema.js:109): `id, timestamp, provider, model, connectionId, apiKey TEXT (per-key since v0.6.28), endpoint, promptTokens, completionTokens, cost REAL, status, tokens TEXT (JSON — cached_tokens / cache_read_input_tokens live here, usageRepo.js:99), meta TEXT`. Plus `usageDaily` (dateKey, data JSON).
- usageRepo: `saveRequestUsage(entry)` :273 (transaction + usageDaily + in-memory ring `pushToRing`); `getUsageHistory(filter)` :348; `getUsageStats(period)` :378 (cachedTokens extraction :413); `getChartData(period)` :700; `calculateCost(provider, model, tokens)` :166 via pricingRepo (`getPricingForModel`, pricingRepo.js:51).
- Recording: only `src/sse/handlers/embeddings.js:140` calls `saveRequestUsage` directly — chat path records usage elsewhere (likely src/models/index.js or chatCore downstream; NOT found by grep in chat.js/models) — **must trace before wiring budget enforcement**.
- API: src/app/api/usage/ routes; facade src/lib/usageDb.js:4.
- Per-key helpers exist: `resolveApiKeyMeta`/`byApiKeyMapKey` (usageRepo.js:25,40), `maskApiKey`, `apiKeyFingerprint`.

## 3. API-key enforcement point
- In-handler, NOT middleware: src/sse/handlers/chat.js:74-98 — `extractApiKey(request)` (auth.js:351: `Authorization: Bearer` then `x-api-key`), then if `settings.requireApiKey`: missing/invalid → `errorResponse(HTTP_STATUS.UNAUTHORIZED,...)`. `isValidApiKey(apiKey)` (auth.js:369) → `validateApiKey(key)` (apiKeysRepo.js:70: `SELECT isActive FROM apiKeys WHERE key = ?`).
- apiKeys schema (schema.js:78): `id, key TEXT UNIQUE, name, machineId, isActive INTEGER, createdAt`. **No budget/limit columns** — per-key 429 shape is net-new; closest existing shape: chat.js `unavailableResponse(status, msg, retryAfter, retryAfterHuman)` ~:280, Retry-After via `formatRetryAfter`.

## 4. modelLock & account selection (src/sse/services/auth.js)
- `getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {})` :28 — filters excluded (~:93 `isModelLockActive(c, model)`), Antigravity quota-cache (:94-99), computes `retryAfterHuman` from earliest lock (:117); returns credentials or `{allRateLimited:true, lastError, lastErrorCode, retryAfter, retryAfterHuman}`.
- `markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null)` :247 — writes `modelLock_${model}` / `modelLock___all` on connection row.
- `clearAccountError(connectionId, currentConnection, model = null)` :306 — clears succeeded model's lock + expired locks.
- chat.js fallback loop: `while(true)` ~:268: getProviderCredentials (:270), allRateLimited branch :273-287, success `clearAccountError` :340, failure `markAccountUnavailable(...)` :515, proxy-group rotation on 429/5xx :422-496 ("Group exhausted → fall through to account fallback" log :496).
- In-memory registry pattern: src/sse/services/antigravityQuota.js — module-level `const quotaCache = new Map(); lastRefreshAt = new Map(); inflightRefresh = new Map()` (:12-16); also `statsEmitTimers` usageRepo.js:71. Copy this pattern.

## 5. Alert insertion points
- All-accounts-locked: chat.js:273-287 (`credentials.allRateLimited` branch, before `unavailableResponse`).
- Proxy pool exhausted: src/lib/network/connectionProxy.js — `resolveConnectionProxyConfig` returns `{source:"none"}` (:217) / `"error"` (:231); sources: "group-direct"(:129), "group"(:140), "pool"(:178), "legacy"(:202). Group-exhausted log: chat.js:495-496.
- Xray node down: src/lib/xray/manager.js `runHealthCheck()` :1367; failed probes :614, :1178-1192 (filter results), :1249 (summary).
- TOTU fetch failure: src/lib/totuAutoFetch/index.js — tick catch :209-210; batch errors in `result.errors`/`result.failed` :167-185.
- Quota-near-limit: ONLY Antigravity has live quota — `antigravityQuotaCache` (antigravityQuota.js:12) holds `{remainingPercentage, resetAt}` per connection+model; refreshed on 409/429 (chat.js:499-502, auth.js:86). Dashboard quota page: src/app/(dashboard)/dashboard/quota/page.js. No generic per-provider quota check.
- **No existing notification/webhook code** — grep webhook/telegram/discord/slack/pushover: nothing. Greenfield.

## Surprises affecting integration
- No central Settings UI — new alert/budget UI needs its own modal/page component (copy TotuAutoFetchModal).
- apiKeys table minimal — budgets require schema.js column additions (TABLES auto-migration handles it).
- Chat usage recording path NOT via direct `saveRequestUsage` grep in chat.js — trace src/models/index.js/chatCore before relying on per-key cost completeness.
- Map-based in-memory registry (antigravityQuota.js) + settings-repo keys = established idiom for config + runtime state.
