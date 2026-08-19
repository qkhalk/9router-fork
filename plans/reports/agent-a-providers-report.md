# Agent A — TokenRouter free-model fix + TOTU AI provider — Report

Date: 2026-08-18
Branch: `feat/providers-tokenrouter-totu` (worktree `wt-a`, base commit 60ddc865)
Scope: registry + suggested-models filter + connection-test + models-route + unit tests + PR + CI

## Changes

### Registry (`open-sse/providers/registry/`)
- `tokenrouter.js` — trimmed the 120-entry seed `models` array to exactly 6:
  - 3 verified-real free ids: `deepseek/deepseek-v4-pro-0813-free`, `qwen/qwen3.8-max-free`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`
  - 3 paid: `openai/gpt-5`, `anthropic/claude-opus-4.8`, `google/gemini-3.6-flash`
  - Removed the stale fake-free `moonshotai/kimi-k3-free`. Added `features: { usage: true, usageApikey: true }`.
  - `modelsFetcher` changed from `{ url: "https://api.tokenrouter.com/v1/models", type: "openai" }` to `{ url: "https://api.tokenrouter.com/api/pricing", type: "pricing" }` (public endpoint; `/v1/models` 401s unauthenticated so "Suggested free models" was empty).
  - `transport/serviceKinds/embeddingConfig/imageConfig/thinkingConfig/passthroughModels` unchanged. Seed comment updated to the "small example set" wording.
- `totu-ai.js` (NEW) — id+alias `totu-ai`, category `apikey`, display{name "TOTU AI", icon "bolt", color "#8B5CF6", textIcon "TA", website "https://totu-ai.com", notice{apiKeyUrl}, transport{baseUrl "https://totu-ai.com/v1/chat/completions", validateUrl "https://totu-ai.com/v1/models"}, 3-model seed (`openai/gpt-5`, `anthropic/claude-opus-4.8`, `google/gemini-3.6-flash`), serviceKinds ["llm","embedding","image"], embeddingConfig{baseUrl …/v1/embeddings, authType apikey, authHeader bearer}, imageConfig{baseUrl …/v1/images/generations}, modelsFetcher{url "https://totu-ai.com/api/pricing", type "pricing"}, passthroughModels true, features{usage:true, usageApikey:true}. No thinkingConfig (TOTU reasoning conventions unverified).
- `orcarouter.js` — kept the already-applied 6-model trim; added `features: { usage: true, usageApikey: true }`.
- `index.js` — hand-edited (migrate script NOT run): added `import p126 from "./totu-ai.js";` and appended `p126,` to the export array.

### App routes
- `src/app/api/providers/suggested-models/filters.js` — added a `pricing` filter: defensive against array-OR-`{data:[...]}`-OR-`{models:[...]}` (route passes `json.data ?? json.models ?? json`; the pricing envelope may arrive keyed), filters `Number(m.model_ratio) === 0` (free only), maps `{ id: m.model_name || m.id, name: m.model_name || m.id }`, filters empty ids, sorts by id. TOTU AI → no free models → `[]` (no suggested section); TokenRouter → exactly the 3 real free ids.
- `src/app/api/providers/[id]/test/testUtils.js` — added `case "tokenrouter"` + `case "totu-ai"` mirroring the `orcarouter` case: `GET validateUrl` with `Authorization: Bearer <apiKey>`, `valid = status !== 401 && status !== 403`, body cancelled, generic "Provider API key rejected (HTTP …)" error. Also added tests below. (Note: switch is on `connection.provider`; the flattened `PROVIDERS[connection.provider].validateUrl` is used.)
- `src/app/api/providers/[id]/models/route.js` — added `tokenrouter: createOpenAIModelsConfig("https://api.tokenrouter.com/v1/models")` and `"totu-ai": createOpenAIModelsConfig("https://totu-ai.com/v1/models")` next to `orcarouter`. Also exported `PROVIDER_MODELS_CONFIG` (previously module-private `const`) so tests can assert the entries defensively.

### Tests (`tests/unit/`)
- `tokenrouter-provider.test.js` (NEW) — seed length 1..6; contains `openai/gpt-5` + all 3 real free ids; `moonshotai/kimi-k3-free` ABSENT; `features.usage`/`features.usageApikey` true; `PROVIDER_MODELS_CONFIG.tokenrouter` defined; `PROVIDERS.tokenrouter.validateUrl` unchanged; usage lists include tokenrouter; `FILTERS.pricing` behavior (free-only, keyed envelope, non-array).
- `totu-ai-provider.test.js` (NEW) — registry id/alias unique; `PROVIDERS["totu-ai"].baseUrl` correct; `PROVIDER_MODELS["totu-ai"]` length ≤ 6; usage flags true; usage lists include totu-ai; pricing modelsFetcher.
- `orcarouter-provider.test.js` — extended with usage-features assertions.

## Verification

- `cd wt-a/tests && npx vitest run unit/tokenrouter-provider.test.js unit/totu-ai-provider.test.js unit/orcarouter-provider.test.js` → 3 files, 32 tests PASS.
- `npx vitest run unit/capabilities.test.js unit/venice-provider.test.js` → 2 files, 9 tests PASS (no shared-contract regression).
- `npx vitest run unit/provider-validation.test.js unit/capabilities.test.js` → 2 files, 28 tests PASS.
- `npx eslint` on all 9 touched files → 0 errors, 3 warnings (`import/no-anonymous-default-export` — same warning pattern as every pre-existing registry file).
- Baselines (`tests/__baseline__/*`) untouched — lead regenerates after merge.

## Constraints honored
- No version bump, no CHANGELOG edit.
- Commit message has no `#NNNN` / `org/repo#NNNN` reference.
- No secrets/keys committed; TOTU notice mentions no key.
- No changes to usage handlers, auto-fetch/UI files, or baseline files.

## PR / CI
- See PR URL + final CI status in agent summary.