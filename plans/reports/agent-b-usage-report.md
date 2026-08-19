# Agent B — per-account $ balance (usage) handlers for tokenrouter / totu-ai / orcarouter

**Status:** DONE
**Branch:** `feat/usage-balance` (base `60ddc865`)
**Worktree:** `C:\Users\DORA\Downloads\test\wt-b`

## What was implemented

### `open-sse/services/usage/newapi.js` (new)
`getNewApiBalanceUsage({ baseUrl, price, quotaPerUnit = 500000, providerName, loginToken, proxyOptions })`:
- No `loginToken` → honest message `"{ProviderName}: no dashboard login token stored. Manual API keys cannot query balance — use Lấy acc (auto-fetch) to add an account and view the remaining $ balance."` — **no network call**.
- `GET <baseUrl>/api/user/self` with `Authorization: Bearer <loginToken>` via `proxyAwareFetch` (mirrors `deepseek.js` pattern).
- 401/403 → `"{ProviderName} login token expired or invalid. Re-add the account (Lấy acc)."`
- !ok → `"{ProviderName} balance API error (<status>): <errText>"`.
- Success: `data = json.data ?? json`; `quota = max(0, toFiniteNumber(data.quota, 0))`, `usedQuota = max(0, toFiniteNumber(data.used_quota, 0))`.
  - `usd = n / quotaPerUnit * price`, `round2 = Math.round(x*100)/100`.
  - Returns `"Remaining ($)"` (total = round2(usd(quota)), remainingPercentage 100/0, unlimited false) and `"Used ($)"` (used = round2(usd(usedQuota)), unlimited true). **No absolute `remaining`** anywhere (QuotaTable treats `remaining` as a 0-100 percentage).
  - Conversion verified in tests: tokenrouter quota 3,500,000 → **49**; totu 3,500,000 → **3.5**.

### `open-sse/services/usage/orcarouter.js` (new)
`getOrcarouterUsage(apiKey = null, proxyOptions = null)` → honest message:
> "OrcaRouter does not expose an account balance API. Balance is tracked per-request via cost headers (X-OrcaRouter-Include-Cost / GET /v1/generation?id=…); no credits or remaining-$ query is available."

### `open-sse/services/usage.js`
Imported both handlers; registered `tokenrouter`, `"totu-ai"`, `orcarouter` in `USAGE_HANDLERS`:
- `tokenrouter` → `getNewApiBalanceUsage({ baseUrl: "https://api.tokenrouter.com", price: 7, providerName: "TokenRouter", loginToken: c.providerSpecificData?.loginToken, ... })`
- `"totu-ai"` → `getNewApiBalanceUsage({ baseUrl: "https://totu-ai.com", price: 0.5, providerName: "TOTU AI", loginToken: c.providerSpecificData?.loginToken, ... })`
- `orcarouter` → `getOrcarouterUsage(c.apiKey, c.proxyOptions)`

## Tests (all green)

| Run | Files | Result |
| --- | --- | --- |
| `unit/newapi-usage.test.js` + `unit/orcarouter-usage.test.js` | 2 files / 9 tests | PASS |
| `unit/deepseek-usage.test.js` + `unit/usage-dispatch.test.js` + `unit/usage-concern.test.js` + `unit/minimax-usage.test.js` + `unit/grok-cli-usage.test.js` | 5 files / 38 tests | PASS |
| all other `unit/*usage*.test.js` (kimi, kiro, github-monthly, opencode-go, ollama, cached-token, embedding-usage, gemini projectid/web, antigravity x2) | 11 files / 94 tests | PASS |
| `unit/orcarouter-provider.test.js` (registry interaction) | 12 tests | PASS |
| **Total** | **18 files / 153 tests** | **PASS** |

ESLint on all 5 touched files: **0 errors**.

## Coverage of acceptance criteria

1. `newapi-usage.test.js` asserts: no-loginToken message with no fetch; tokenrouter → 49, totu → 3.5; 401 message; dispatch reaches handler for both `tokenrouter` and `"totu-ai"` (asserting returned shape). Also asserts the request URL/headers (Bearer login token, not sk- key) and that no absolute `remaining` is emitted.
2. `orcarouter-usage.test.js` asserts the honest message and dispatch routing for `orcarouter`.

## Not covered (Agent A's files — must be re-verified after merge)

`USAGE_SUPPORTED_PROVIDERS` / `USAGE_APIKEY_PROVIDERS` derive from registry `features.usage` / `features.usageApikey`, which land in a **separate PR** (registry features for tokenrouter / totu-ai / orcarouter). At base `60ddc865` those registry entries have **no** `features` block, and there is **no `totu-ai` registry file**. The orcarouter-usage test therefore asserts the handler + dispatch only, with an inline NOTE that the list-inclusion assertion must be added after the registry-features PR merges. No registry/baseline/UI files were touched.

## Verification math

- tokenrouter: `3500000 / 500000 * 7 = 49` → `Remaining ($).total === 49`
- totu: `3500000 / 500000 * 0.5 = 3.5` → `Remaining ($).total === 3.5`
- used: `100000 / 500000 * 7 = 1.4` (tokenrouter), `100000 / 500000 * 0.5 = 0.1` (totu)

## Files changed

- `open-sse/services/usage/newapi.js` (new)
- `open-sse/services/usage/orcarouter.js` (new)
- `open-sse/services/usage.js` (edited)
- `tests/unit/newapi-usage.test.js` (new)
- `tests/unit/orcarouter-usage.test.js` (new)
- `plans/reports/agent-b-usage-report.md` (this report)

No version bump, no CHANGELOG, no registry/filters/testUtils/models-route/baselines/UI changes.
