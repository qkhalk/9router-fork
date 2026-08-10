# Codebase Summary

> A code-grounded map of the repository. LOC figures are approximate counts of
> source files (`.js/.jsx/.ts/.tsx/.py/.sh/.css` etc.), excluding
> `node_modules`, `.git`, `.next`, `dist`.

## Top-level layout

```
9router/
├── src/              # Next.js application (UI + API routes + local backend)
├── open-sse/         # Provider-agnostic request engine (translation, execution, streaming)
├── cli/              # `9router` npm CLI (launch, terminal UI, tray)
├── tests/            # Vitest suite (translator snapshots, unit, fixtures)
├── scripts/          # Build/migration helper scripts
├── public/           # Static assets
├── gitbook/          # Separate Next.js docs-site subapp (excluded from main build)
├── docs/             # This documentation (source of truth)
├── *.py / *.sh / *.js (root)  # Maintenance & ops helper scripts
├── custom-server.js  # Next.js custom HTTP server (real-IP injection, header stripping)
├── https-server.js   # Local HTTPS front (self-signed certs) → internal Next server
├── Dockerfile, DOCKER.md, start.sh, captain-definition
├── next.config.mjs   # Standalone build, /v1 rewrites, body-size & tracing config
└── package.json      # 9router-app (private)
```

## Approximate LOC by area

| Area | Files | LOC (approx) | Role |
|---|---|---|---|
| `src/app` | ~290 | ~47,400 | Next.js App Router: pages + API routes (~140 `route.js`) |
| `src/lib` | ~135 | ~17,650 | Local backend: DB, auth, xray, tunnel, network, MITM certs, ds2api, headroom, mcp, updater |
| `src/shared` | ~80 | ~10,900 | Reusable UI components, hooks, constants, bootstrap |
| `src/mitm` | ~17 | ~3,300 | HTTPS interception proxy for AI IDEs |
| `src/sse` | ~13 | ~2,600 | SSE request handlers bridging API routes → `open-sse` |
| `src/store` | 7 | ~250 | Zustand client stores |
| `src/i18n` | 3 | ~380 | Runtime DOM i18n (35 locales) |
| `open-sse` | ~380 | ~52,200 | Engine: executors, translators, handlers, services, registry |
| `cli` | ~24 | ~6,500 | `9router` CLI launcher + terminal UI + tray |
| `tests` | ~205 | ~30,000 | Vitest tests + fixtures + baseline |

## `src/` — the application

### `src/app/` (Next.js App Router)

- **`(dashboard)/dashboard/*`** — authenticated UI pages: `providers`, `combos`,
  `endpoint`, `usage`, `quota`, `cli-tools`, `proxy-pools`, `xray` (V2Ray),
  `mitm`, `translator`, `media-providers`, `token-saver`, `skills`, `profile`
  (settings), `console-log`, `basic-chat`, `pxpipe`.
- **`api/`** — ~140 route handlers. Key groups: `api/v1/` (OpenAI-compatible:
  `chat/completions`, `messages`, `responses` (+ `responses/compact`),
  `embeddings`, `images`, `audio/{speech,transcriptions,voices}`, `videos`,
  `models`, `search`, `web`), `api/auth/` (login, logout, status, OIDC,
  reset-password), `api/oauth/` (dynamic `[provider]/[action]` + per-provider
  import routes), `api/providers/` (+ `provider-nodes/`), `api/combos/`,
  `api/keys/`, `api/usage/`, `api/settings/`, `api/xray/`, `api/mcp/`,
  `api/proxy-pools/`, `api/translator/`, `api/tunnel/`, `api/ds2api/`,
  `api/headroom/`, `api/pxpipe/`, `api/cli-tools/`, `api/media-providers/`.
- **`layout.js` / `page.js`** — root layout (ThemeProvider, i18n, GA, console
  capture) and root redirect to `/dashboard`.
- **`globals.css`** — Tailwind v4 theme, brand palette, dark mode.

### `src/lib/` — local backend

- **`db/`** — multi-driver SQLite: `driver.js` (bun → better-sqlite3 →
  node:sqlite → sql.js), `schema.js` (declarative tables + WAL PRAGMAs,
  `SCHEMA_VERSION = 2`), `migrate.js` (versioned + additive auto-sync),
  `paths.js`, `repos/` (one repository per entity), `adapters/`.
- **`auth/`** — `dashboardSession.js` (JWT + bcrypt), `oidc.js` (PKCE),
  `loginLimiter.js` (rate limiting).
- **`xray/`** — **v2go / managed Xray-core V2Ray proxy** (v0.6.0):
  `installer.js` (binary download/extract), `parser.js` (share-link →
  outbound JSON, a JS port of v2go's Go converter), `configBuilder.js`
  (SOCKS+HTTP inbound config), `process.js` (spawn/stop/restart + temp test
  instance), `tester.js` (latency/exit-IP probes), `sync.js` +
  `syncParse.js` (subscription fetcher + scheduler), `manager.js`
  (orchestration facade + state machine).
- **`ds2api/`** — DS2API (DeepSeek-Web) managed sidecar: `install.js` (auto-download release binary per OS/arch + sha256 verify + extract), `process.js` (spawn/stop lifecycle + generated admin/api credentials), `detect.js` (binary detection + health probe), `adminClient.js` (JWT admin REST API client), `resolve.js` (runtime `PROVIDERS.ds2api` baseUrl sync), `context.js` (route runtime resolver).
- **`headroom/`** — Headroom token-compression proxy lifecycle (`process.js`,
  `detect.js` with `code`/`ml` extras probing).
- **`tunnel/`** — `cloudflare/manager.js`, `tailscale/manager.js`, `shared/`
  (watchdog, state, internet/DNS checks).
- **`network/`** — `outboundProxy.js`, `connectionProxy.js` (per-connection
  pool resolution), `proxyRotation.js` (group rotation + cooldowns),
  `proxyTest.js`, `initOutboundProxy.js`.
- **`mcp/`** — `stdioSseBridge.js` (preset local stdio MCP plugins → SSE,
  RCE-safe: only preset plugins may spawn).
- **`updater/`** — `updater.js` (detached self-update process, port 20129
  status server, `UPDATER_*` env vars).
- **`oauth/`** — OAuth flow orchestrator (`providers/index.js` with flow
  handlers per provider: PKCE / device-code / import-token / RSA-keypair).
- **`pxpipe/`** — PXPIPE image-context-compression sidecar lifecycle.
- **`qoder/`** — re-export shim to `open-sse/shared/qoder/` (COSY signing).
- Notable: `dataDir.js`, `consoleLogBuffer.js`, `mitmAliasCache.js`.

### `src/shared/` — UI + shared logic

- **`components/`** — `Header`, `Sidebar`, `OAuthModal`, `ModelSelectModal`,
  `EditConnectionModal`, `UsageStats`, `PricingModal`, and ~40 more.
- **`services/`** — `bootstrap.js`, `initializeApp.js` (post-auth setup).
- **`hooks/`** — `useTheme.js`, etc.
- **`constants/`** — `providers.js`, `models.js`, `config.js`.
- **`utils/`** — `api.js` (typed API client functions), `ssrfGuard.js` (SSRF protection).

### `src/mitm/` — interception proxy

- `server.js` (HTTPS + SNI + HTTP/2), `manager.js` (process lifecycle, DNS),
  `config.js` (target domains, model patterns).
- `handlers/` — `base.js`, `kiro.js` (AWS EventStream), `copilot.js`,
  `antigravity.js`, `cursor.js` (binary protocol).
- `cert/` — generate + install; `dns/dnsConfig.js` — `/etc/hosts` manipulation.

### `src/sse/` — SSE gateway layer

Thin layer that turns HTTP requests into streamed responses by delegating to
`open-sse`:

- `handlers/` — `chat.js` (→ `handleChat` / `handleSingleModelChat` /
  `handleComboChat` / `handleFusionChat`), `embeddings.js`,
  `imageGeneration.js`, `search.js`, `stt.js`, `tts.js`, `videoGeneration.js`,
  `fetch.js`.
- `services/` — `auth.js` (credential selection + per-model lock + proxy-group
  rotation + fallback), `model.js` (alias/combo/single resolution +
  `getComboModels`), `backgroundTokenRefresh.js`, `tokenRefresh.js`.

### `src/store/` — Zustand stores

`providerStore`, `settingsStore`, `themeStore`, `notificationStore`,
`headerSearchStore`, `userStore` (client-side, TTL-cached where relevant).

### `src/i18n/`

Runtime DOM translation: `config.js` (35 locales), `runtime.js`
(MutationObserver-driven, text-node matching against JSON dictionaries in
`public/i18n/literals/<locale>.json`), `RuntimeI18nProvider.js`.

## `open-sse/` — the engine

Provider-agnostic core that turns one OpenAI-style request into a call to any
provider and streams the response back in the client's format.

| Subdir | Role |
|---|---|
| `config/` | Constants, runtime timeouts/retry, error/backoff config |
| `executors/` | ~40 per-provider HTTP clients (`base.js` `BaseExecutor` + specialized: azure, vertex, codex, cursor, kiro, gemini-web, gemini-cli, github, antigravity, qoder, grok-web, perplexity-web, codebuddy-cn, mimo-free, cloudflare-ai, commandcode, …) |
| `handlers/` | Modality orchestrators: `chatCore.js` (+ `chatCore/` streaming/non-streaming/SSE→JSON/forced-SSE-to-JSON), `responsesHandler.js` (Responses Lite), `embeddingsCore.js`, `imageGenerationCore.js`, `ttsCore.js`, `sttCore.js`, `search/` |
| `translator/` | Bidirectional format conversion across 14 source formats; `formats/`, `request/`, `response/`, `schema/`, modular `concerns/` (toolCall, thinking/reasoning, message, chunk, usage, image, modality, finishReason, …). Direct routes preferred; OpenAI is the pivot fallback. |
| `services/` | `model.js`, `provider.js`, `accountFallback.js`, **`combo.js`** (fallback/round-robin/fusion + capability tiering), **`capacityAdapter.js`** (vision/pdf/audio/video fallback pool), `oauthCredentialManager.js`, `tokenRefresh.js` (centralized per-provider refresh handlers), `usage/` (per-provider usage parsers incl. Antigravity Gemini-3.x quota tracker), Gemini-Web session/cookie/RPC/keepalive/fingerprint cluster (8 files), `projectId.js` (Vertex) |
| `rtk/` | Token-saver pipeline (fail-open, ordered): `index.js` + `filters/` (11 files) compress `tool_result`; `headroom.js` (external `/v1/compress` proxy, reports effective savings), `caveman.js` (−65% output tokens), `ponytail.js` (lazy senior dev, Lite/Full/Ultra). PXPIPE image compression is a sibling step wired from `src/lib/pxpipe/`. |
| `transformer/` | `responsesTransformer.js` (Chat Completions SSE → Codex Responses API SSE), `streamToJsonConverter.js` |
| `utils/` | `stream.js`, `streamHandler.js`, `sse.js`, `proxyFetch.js`, `bypassHandler.js`, `clientDetector.js`, `claudeCloaking.js`, `cursorChecksum.js`/`cursorProtobuf.js`, `usageTracking.js`, `error.js`, `requestLogger.js` |
| `providers/`, `shared/` | Provider registry (`registry/` — **122 provider files**, the single source of truth, each self-contained with `display`/`category`/`models`/`authModes`), `pricing.js` ($/1M tokens), `capabilities.js`, `schema.js`, `models/`. `shared/` has `qoder/` (COSY signing), `zedAuth.js` (RSA keypair). |

Entry: `open-sse/index.js` (re-exports config, translators, services, handlers,
stream utils). Imported for side effects (HTTP proxy env wiring) at the top of
`src/sse/handlers/chat.js`.

### Gemini-Web cluster

A dedicated subsystem for session/cookie-based access to Gemini via the web interface (not API):

- `open-sse/executors/gemini-web.js` — executor using Gemini Web RPC protocol
- `open-sse/services/geminiWebSession.js` — session management (login, token refresh)
- `open-sse/services/geminiWebCookiePool.js` — multi-account cookie rotation pool
- `open-sse/services/geminiWebCookie.js` — individual cookie lifecycle
- `open-sse/services/geminiWebKeepAlive.js` — keepalive to prevent session expiry
- `open-sse/services/geminiWebFingerprint.js` — browser fingerprint simulation
- `open-sse/services/geminiWebRpc.js` — RPC protocol (batchexecute, streamgenerate)
- `open-sse/services/geminiWebModels.js` — model listing from web session
- `open-sse/services/geminiWebUsage.js` — usage tracking for web sessions
- `tests/fixtures/gemini-web/` — 15 fixture files for Gemini-Web testing
- `add-gemini-web.sh`, `update-gemini-cookies.sh`, `gemini-health-check-runner.js` — ops scripts

### Web-based executors

Three executors that use session cookies (not API keys) to access web versions:
- **`grok-web`** (`open-sse/executors/grok-web.js`) — xAI Grok via web interface
- **`perplexity-web`** (`open-sse/executors/perplexity-web.js`) — Perplexity via web interface
- **`gemini-web`** (`open-sse/executors/gemini-web.js`) — Google Gemini via RPC protocol

### Provider registry

The provider registry in `open-sse/providers/registry/` contains **122
individual provider definition files**, each a self-contained module exporting
`alias`, `display`, `category` (`free`/`freeTier`/`oauth`/`apikey`/`webCookie`),
`authModes`, `models[]` (kind-tagged: `llm`/`image`/`tts`/`stt`/`embedding`/…),
media configs, and `thinkingConfig`. The `registry/index.js` imports them all
into one array (3 are imported but hidden pending tool-calling support:
`trae`, `windsurf`, `devin-cli`). `open-sse/providers/index.js` derives four
maps (`PROVIDERS`, `PROVIDER_MODELS`, `PROVIDER_OAUTH`, `PROVIDER_MEDIA`) from
the registry — it is the single source of truth; `src/lib/oauth/` and
`src/shared/constants/providers.js` both derive from it and do not redefine
provider metadata. `pricing.js` holds per-model $/1M-token rates
(`PROVIDER_PRICING` → `MODEL_PRICING` → `PATTERN_PRICING` fallback).

### RTK (Response Token Kernel)

Token-reduction layer that compresses verbose `tool_result` content before it reaches the LLM — 16 files total:

- `open-sse/rtk/index.js` — entry point, orchestrates compression pipeline
- `open-sse/rtk/autodetect.js` — auto-detects tool output type from first 1KB
- `open-sse/rtk/filters/` — **11 filter files**: `gitDiff.js`, `gitStatus.js`, `grep.js`, `find.js`, `ls.js`, `tree.js`, `dedupLog.js`, `smartTruncate.js`, `readNumbered.js`, `searchList.js`, `buildOutput.js`
- `open-sse/rtk/headroom.js` — external Headroom proxy compressor integration
- `open-sse/rtk/caveman.js` + `cavemanPrompts.js` — "caveman speak" system-prompt injector (3 levels, −65% output tokens)
- `open-sse/rtk/ponytail.js` + `ponytailPrompt.js` + `systemInject.js` — "lazy senior dev" system-prompt injector (Lite/Full/Ultra)

## `cli/` — the `9router` CLI

Distributed as a GitHub Releases tarball (npm package name `9router`, **not**
published to the npm registry). Lockstep versioned with `9router-app`.

- `cli/cli.js` (~890 LOC) — entry: flags `-p/--port` (default 20128),
  `-H/--host`, `-n/--no-browser`, `-l/--log`, `-t/--tray`, `--skip-update`,
  `-v/--version`; plus the `xai video` subcommand (Grok Imagine generation).
  Kills prior 9router/cloudflared/tailscale/MITM processes, frees the port,
  spawns `custom-server.js` detached (`--max-old-space-size=6144`), runs an
  update check, and offers Web UI / Terminal UI / Tray / Exit menu. Crash
  recovery: up to 2 restarts within 30s.
- `src/cli/terminalUI.js` + `menus/` (providers, apiKeys, combos, settings,
  cliTools) and `api/client.js` (HTTP to the running server).
- `src/cli/tray/` — system tray (PowerShell `NotifyIcon` on Windows — zero
  binary; `systray2` lazy-installed into `~/.9router/runtime` on mac/linux);
  OS auto-start (`autostart.js`).
- `hooks/` — `postinstall.js` (runtime warm-up, installs `better-sqlite3`
  into `~/.9router/runtime` to avoid Windows EBUSY on global update),
  `sqliteRuntime.js`, `trayRuntime.js`.
- `scripts/build-cli.js` — builds the Next.js standalone app (separate
  `.next-cli-build` dist), copies it + `custom-server.js` + MITM (esbuild
  bundle) + updater + sql.js + `open` into `cli/app/`, then `npm pack`.

The CLI includes quick-setup wizards for Claude Code, Codex CLI, Factory Droid, Open Claw, OpenCode, Hermes Agent, and other AI coding tools (`cli/src/cli/menus/cliTools.js`).

## `tests/`

Vitest. Layout:

- `tests/translator/` — **15 golden + regression test files** for translation (incl. `real/` and `__snapshots__/`)
- `tests/unit/` — **89 unit test files** covering executors, capabilities, DB, routing, gemini-web, image, embeddings, mitm/antigravity, combo, fusion, translator concerns
- `tests/__baseline__/` — **11 baseline verification scripts** (verify-providers, verify-alias, verify-no-regression, snapshot-providers, verify-oauth-urls) and 6 JSON baseline files (providers, aliases, OAuth URLs)
- `tests/fixtures/` — mock provider payloads (15 Gemini-Web fixtures, provider response dumps)

A data-driven translator coverage matrix maps which format pairs are tested and which remain implicit (via OpenAI bridge). Run from the `tests/` directory; the root `package.json` has no `test` script.

## Root helper scripts

Maintenance/ops tooling (not runtime):

- `custom-server.js`, `https-server.js`, `start.sh` — server launch / Docker.
- `install.sh`, `install.ps1` — one-liner installers (`npm i -g <release tarball>`).
- `fix_provider_models.py`, `uncomment.py`, `fix-theme.py` — one-off code fixes.
- `add-gemini-web.sh`, `update-gemini-cookies.sh`,
  `gemini-health-check-runner.js` — Gemini-Web account ops.
- `check-db.js`, `test-db.js` — SQLite inspection.
- `scripts/` — `gemini-web-health-check.js`, `injectDisplayToRegistry.mjs`,
  `migrate-registry.mjs` (one-shot registry codemods), `test-combo-autoswitch.mjs`,
  `translate-readme.js`, `copy-standalone-assets.mjs` (postbuild).

## `gitbook/`

A **separate** Next.js docs-site subapp, excluded from the main build via
`outputFileTracingExcludes` and the webpack watcher (`next.config.mjs`). Built
and deployed by `.github/workflows/gitbook-pages.yml`. Not part of the runtime
application.
