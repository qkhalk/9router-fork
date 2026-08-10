# System Architecture

> How 9Router fits together and how a request flows end-to-end. All statements
> are traceable to source. Note: there is also a legacy `docs/ARCHITECTURE.md`
> (fork-inherited prose); this file supersedes it where they differ.

## 1. High-level topology

```
                ┌──────────────────────────────────────────────────────────┐
   LLM clients  │  OpenAI / Claude / Gemini SDKs, AI IDEs, the 9router CLI  │
   (any shape)  └─────────────────────────┬────────────────────────────────┘
                                           │  HTTPS (/v1, /v1/messages, /codex, /responses, …)
                                           ▼
        ┌──────────────────────────────────────────────────────────────┐
        │ Next.js custom server  (custom-server.js)                     │
        │  • strips spoofable x-forwarded-for / x-real-ip              │
        │  • injects x-9r-real-ip (socket IP) for rate-limiting        │
        │  • rewrites: /v1/* /v1/v1/* /v1beta/* /codex/* /responses    │
        │    → /api/v1/*                                                │
        └────────────────────────────────┬─────────────────────────────┘
                                         │
        ┌────────────────────────────────┴─────────────────────────────┐
        │ src/dashboardGuard.js (proxy middleware)                      │
        │  • PUBLIC_API (health/init/auth + /v1/* LLM endpoints w/ API  │
        │    key auth)  • PROTECTED_API (settings/keys/providers/...)   │
        │  • LOCAL_ONLY for process-spawning routes (xray/mitm/ds2api/  │
        │    tunnel)  • CLI token (x-9r-cli-token) for local tools      │
        └────────────────────────────────┬─────────────────────────────┘
                                         │
        ┌────────────────────────────────┴─────────────────────────────┐
        │ src/app/api/v1/*  (thin route handlers)                       │
        └────────────────────────────────┬─────────────────────────────┘
                                         │
        ┌────────────────────────────────┴─────────────────────────────┐
        │ src/sse/handlers/*  (gateway: auth, model resolution, combo,  │
        │   capacity adapter)                                          │
        └────────────────────────────────┬─────────────────────────────┘
                                         │  handleChatCore / handleComboChat / handleFusionChat
        ┌────────────────────────────────┴─────────────────────────────┐
        │ open-sse engine                                                │
        │  detect caps → translate → token-saver chain → select executor │
        │  → call provider → stream-transform response back to client   │
        └────────────────────────────────┬─────────────────────────────┘
                                         │  outbound HTTPS (optional HTTP_PROXY/HTTPS_PROXY,
                                         │   per-connection proxy pool, or v2go SOCKS)
                                         ▼
                              Upstream LLM providers
```

Separate inbound path for AI IDEs that can't be re-pointed at `/v1`:

```
   Cursor / Kiro / Copilot / Antigravity
        │ (DNS hijacked to 127.0.0.1 via /etc/hosts; root CA installed)
        ▼
   src/mitm/server.js  (HTTPS + SNI + HTTP/2 interception)
        │  maps intercepted model → user provider via `mitmAlias`
        └──► reuses the same open-sse pipeline above
```

## 2. End-to-end request lifecycle (chat completion)

Traceable from `src/app/api/v1/chat/completions/route.js`:

1. **Ingress & rewrite.** `next.config.mjs` rewrites `/v1/chat/completions`
   (and `/v1/v1/...`, `/codex/...`) to `/api/v1/chat/completions`. The custom
   server injects the real client IP before Next handles it.
2. **Route handler.** `route.js` parses the body and calls
   `handleChat(request)` in `src/sse/handlers/chat.js`.
3. **Auth gate.** `handleChat` reads `settings.requireApiKey`; if set, it
   validates the bearer key via `isValidApiKey()` (`src/sse/services/auth.js`)
   and returns `401` on failure.
4. **Format detection.** `detectFormat()` + `detectFormatByEndpoint()`
   (`open-sse/translator/formats.js`) identifies the client format (OpenAI /
   Claude / Gemini / Responses / Antigravity / Kiro / Cursor / …).
5. **Capability detection.** `detectRequiredCapabilities(body)` scans the
   trailing user turn for modality blocks (`vision` / `pdf` / `audioInput` /
   `videoInput`) — the HARD_CAPS used by the capacity adapter.
6. **Model resolution.** `src/sse/services/model.js` resolves the `model`
   string: alias → combo → single provider model (`getModelInfo` /
   `getComboModels`). Model strings use `provider/model` or an alias.
7. **Credential selection.** `getProviderCredentials()` selects an active
   connection for the resolved provider (mutex-protected, model-locked/excluded
   connections filtered, `fill-first` or `round-robin` strategy), refreshing
   OAuth tokens via `checkAndRefreshToken()` when needed and resolving any
   per-connection proxy pool.
8. **Combo vs single + capacity adapter.**
   - Single model → `handleSingleModelChat()`; if the request needs a capability
     the model lacks, it is routed through `handleComboChat()` with the capacity
     adapter's pool prepended.
   - Combo → `augmentModelsWithCapacityAdapter()` first (prepends capable pool
     models only if no combo member satisfies the request), then
     `handleComboChat()` (fallback / round-robin) or `handleFusionChat()`
     (fusion) from `open-sse/services/combo.js`.
9. **Inside `open-sse` `handleChatCore`:**
   1. `handleBypassRequest()` short-circuits warmup/naming-skip patterns.
   2. **Passthrough** detection (`isNativePassthrough`) skips translation.
   3. **Capability concerns** strip unsupported modalities per model
      (`translator/concerns/`); `prefetchRemoteImages`.
   4. **Translate request** to the provider's format (`translator/index.js`;
      direct route preferred, else pivot through OpenAI).
   5. **Token-saver chain** (fail-open, order matters, opt-out via
      `TOKEN_SAVER_HEADER: off`): RTK compress → Headroom proxy → Caveman
      inject → Ponytail inject → PXPIPE image compress.
   6. **Select executor** (`executors/index.js`) — `DefaultExecutor` or a
      provider-specific one (cursor, kiro, gemini-web, vertex, qoder, …).
   7. **Execute** (`executors/base.js`) — build URL/headers, call provider
      with retry, fallback URLs, and credential refresh; honor outbound proxy
      env vars and per-connection proxy via `utils/proxyFetch.js`; validate
      target via `ssrfGuard.js`.
9. **Response streaming.** `handlers/chatCore/streamingHandler.js` (or
   `nonStreamingHandler.js`) builds an SSE transform pipeline
   (`utils/stream.js`): converts provider SSE → client format, maps tool
   names, tracks usage, and watches for disconnect/stall (`streamHandler.js`).
10. **Usage logging.** Tokens/cost/status are written to `usageHistory` (and
    daily rollups to `usageDaily`); full payloads to `requestDetails` when
    request-detail capture is on.
11. **Failure & fallback.** On a retryable error (429/401/5xx + provider-specific
    error strings via `checkFallbackError`), `handleSingleModelChat` first
    rotates the **proxy group** entry (cooldown 60s rate-limit / 30s 5xx) and
    retries the *same account*, then falls back to the next **account**:
    `markAccountUnavailable(model)` with per-model `modelLock_*` + backoff;
    `excludeConnectionIds` grows until all are exhausted (`unavailableResponse`).
    Earliest `retryAfter` wins for the final 503.

### Responses API path

`/v1/responses` is handled by a dedicated route handler
(`src/app/api/v1/responses/route.js`) that delegates to the same `handleChat`
pipeline. The `responsesHandler.js` in `open-sse/handlers/` converts Responses
API format to Chat Completions format via `convertResponsesApiFormat()`
(`open-sse/translator/formats/responsesApi.js`), then calls `handleChatCore`.
On the response side, `responsesTransformer.js` converts Chat Completions SSE
chunks into Responses API SSE format, and `streamToJsonConverter.js` handles
non-streaming Responses.

## 3. The `open-sse` engine (internal architecture)

`open-sse` is a self-contained ESM package consumed by the app via
`open-sse/index.js` (also imported for side effects — it wires HTTP proxy env
vars).

- **Handlers** = modality orchestrators (`chatCore` + `chatCore/` sub-handlers,
  `responsesHandler`, `embeddingsCore`, `imageGenerationCore`, `ttsCore`,
  `sttCore`, `search`).
- **Translators** = bidirectional format conversion across 14 source formats
  (`openai`, `openai-responses`, `claude`, `gemini`, `gemini-cli`, `gemini-web`,
  `vertex`, `codex`, `antigravity`, `kiro`, `cursor`, `ollama`, `commandcode`).
  Direct routes (e.g. `claude↔kiro`, `antigravity↔openai`) are preferred; the
  OpenAI format is the pivot fallback. Organized into `formats/`, `request/`,
  `response/`, `schema/`, and modular `concerns/` (toolCall, thinking,
  reasoning, message, chunk, usage, image, modality, …).
- **Executors** = ~40 provider HTTP clients; `base.js` (`BaseExecutor`)
  provides URL/header build, retry, fallback-URL, credential-refresh;
  specialized executors add provider protocols (protobuf for Cursor, AWS
  EventStream for Kiro, RPC for Gemini-Web, COSY signing for Qoder, etc.).
- **Services** = cross-cutting: model/provider resolution, account fallback,
  **combos + capacity adapter**, OAuth credential management + centralized
  token refresh (`tokenRefresh.js` with per-provider handlers), per-provider
  usage parsers (`services/usage/` — incl. the Antigravity Gemini-3.x quota
  tracker), and the Gemini-Web session/cookie/RPC/keepalive cluster (8 files).
- **RTK / token saver** = fail-open pre-translate pipeline that compresses tool
  output (git diff/status, logs, grep/find/ls) and injects token-frugal system
  prompts. Chain order: RTK (`filters/`, 11 files) → Headroom
  (`rtk/headroom.js`, external `/v1/compress` proxy) → Caveman (`caveman.js`,
  −65% output tokens) → Ponytail (`ponytail.js`, "lazy senior dev") → PXPIPE
  (image context compression sidecar). Each step reports effective savings and
  is opt-out per-request via `TOKEN_SAVER_HEADER: off`.
- **Transformer** = `responsesTransformer.js` (Chat Completions SSE → Codex
  Responses API SSE), `streamToJsonConverter.js` (Responses non-streaming).
- **Config / registry** = single source for timeouts, retry/backoff, error
  mapping, and the provider/model registries (built from
  `providers/registry/` — 122 provider files; `pricing.js`,
  `capabilities.js`, `schema.js`).

### The token-saver pipeline (chat)

Before translation, `chatCore.js` runs a series of **fail-open** hooks that
mutate the request body in-place. Each hook returns null on error, leaving
the body untouched. Order matters; all are opt-out per-request via
`TOKEN_SAVER_HEADER: off`:

```
Body → RTK compress (tool_result) → Headroom (/v1/compress proxy)
     → Caveman (system inject, −65% output) → Ponytail (system inject,
       Lite/Full/Ultra) → PXPIPE (image context compress)
     → Translate → Execute
```

- **RTK** (`rtk/index.js` + `rtk/filters/`) compresses `tool_result` blocks
  by auto-detecting their type (git diff, grep, ls, etc.) and applying
  format-preserving compression. Safe by design — if a filter fails, the
  original text is kept.
- **Headroom** (`rtk/headroom.js`) forwards the request body to an optional
  external Headroom proxy (`/v1/compress`). If the proxy is down or returns an
  error, 9Router fails open and sends the original request. The Headroom
  subprocess lifecycle is managed by `src/lib/headroom/process.js` with a
  dashboard UI for start/stop/status (`/api/headroom/*`). It reports effective
  payload savings (token delta + before/after body/message/tool bytes).
- **Caveman** (`rtk/caveman.js`) injects a caveman-speak system prompt
  ("why use many token when few token do trick") in 3 levels — −65% output tokens.
- **Ponytail** (`rtk/ponytail.js`) injects a "lazy senior dev" system prompt
  (Lite/Full/Ultra) that biases the LLM toward minimal, YAGNI-first code.
- **PXPIPE** (`src/lib/pxpipe/`) is an optional image-context-compression
  sidecar that shrinks base64 image payloads before dispatch.

### Combos & capacity adapter

A **combo** is a user-defined virtual model name (stored in the `combos` table)
that fans out to an ordered list of real `provider/model` strings. Three
strategies (per-combo or global default in `settings.comboStrategy`):

- **fallback** — try models in order, fall through on `checkFallbackError`
  retryable errors (with a small wait for transient 502/503/504).
- **round-robin** — rotate the start index per request (in-memory
  `comboRotationState`, sticky limit `comboStickyRoundRobinLimit`), then fallback.
- **fusion** — fan the prompt to all panel models in parallel (non-streaming,
  tools stripped), collect with quorum-grace, then a **judge model**
  synthesizes one answer from anonymized "Source N" outputs.

The **capacity adapter** (`open-sse/services/capacityAdapter.js`) is the
vision/audio fallback pool. When a request needs a HARD_CAP (`vision`, `pdf`,
`audioInput`, `videoInput`) that no combo member (or single target model)
satisfies, capable pool models are **prepended** as priority candidates — never
overriding a model that already has the capability. Default fallback model is
`oc/mimo-v2.5-free`. When the chain falls into an adapter model,
`withCapacityAdapterStripping` trims message history (drops the middle, keeps
system + first 6 + trailing user turn) at 80% of the adapter's context window.
Defaults: vision + audioInput enabled, pdf + videoInput disabled.


### DS2API sidecar provider

**DS2API** (`open-sse/providers/registry/ds2api.js`) is a registered provider that
exposes DeepSeek web chat as an OpenAI-compatible API via a managed local sidecar
process (the `ds2api` Go binary, which pools DeepSeek accounts and solves PoW).

Integration is "Tier B" — 9router owns the full lifecycle and configuration:

- **Binary install** (`src/lib/ds2api/install.js`): auto-downloads the matching
  GitHub release artifact per OS/arch, sha256-verifies it, and extracts it into
  `DATA_DIR/ds2api` (`DS2API_VERSION`, overridable via env). No Go toolchain needed.
- **Lifecycle** (`src/lib/ds2api/process.js`, `detect.js`): spawn/stop/health-probe
  the sidecar. On first start 9router generates strong `adminKey` + caller `apiKey`
  secrets (`credentials.json`, mode 0600); the admin key is passed via
  `DS2API_ADMIN_KEY`, config persisted via `DS2API_CONFIG_PATH`.
- **Config bridge** (`src/lib/ds2api/adminClient.js`): 9router drives ds2api's JWT
  admin REST API (`/admin/*`) to manage DeepSeek-web accounts, keys, queue, and
  settings from the 9router dashboard, so the user never touches ds2api's own UI.
- **Auto-injection**: after start, 9router ensures the managed caller key is in
  ds2api's `keys` and registers a `ds2api` provider connection carrying it, so the
  existing executor routes with `Authorization: Bearer <key>` (the registry uses
  `authType: "apikey"` + `transport.auth`, `passthroughModels: true`).
- **Routing sync** (`src/lib/ds2api/resolve.js`): `PROVIDERS.ds2api.baseUrl` is
  patched at runtime from the `ds2apiUrl` setting (loopback default
  `http://localhost:5001`).
- **Reverse proxy** (`/api/ds2api/proxy/[...path]`): auth-gated streaming passthrough
  to the internal sidecar for advanced/raw access.

Dashboard UI lives in
`src/app/(dashboard)/dashboard/providers/[id]/Ds2apiManager.js`, rendered on the
DeepSeek Web provider detail page (`/dashboard/providers/ds2api`), where users
install/start the engine, manage the DeepSeek-account pool, and see available
models. API routes under `/api/ds2api/*` are deny-by-default auth-gated
(`src/dashboardGuard.js`), and the process-spawning routes
(`install`/`start`/`stop`) are further restricted to localhost via
`LOCAL_ONLY_PATHS`.

**Security note:** ds2api binds `0.0.0.0:<port>` (hardcoded upstream), so on
shared/LAN hosts the internal port is technically reachable; 9router reverse-proxies
browser access, auto-generates strong admin/api keys, and does not advertise the
port, but a host firewall is recommended on multi-user machines. (A loopback-only
bind would require forking ds2api.)

### V2Ray proxy (v2go) — managed Xray-core client

The v2go integration (`src/lib/xray/`, new in v0.6.0) turns V2Ray share links
into a local SOCKS5+HTTP proxy that 9router treats as a first-class proxy pool.
The config catalog is seeded by syncing the upstream
[v2go subscription](https://github.com/Danialsamadi/v2go) (~1,000+ working
configs, refreshed hourly).

- **Binary install** (`installer.js`): auto-downloads the official Xray-core
  release (default `v26.3.27`, env `XRAY_VERSION`) per OS/arch into
  `<DATA_DIR>/xray/`, extracts it, and writes MPL-2.0 attribution.
- **Share-link parser** (`parser.js`): a documented line-for-line JS port of
  v2go's Go converter. Supports `vless`, `vmess`, `ss`, `trojan`, `hysteria2`;
  transports `tcp`/`ws`/`grpc`/`httpupgrade`/`xhttp`; security `none`/`tls`/`reality`.
  `validateLink()` rejects REALITY + ws (Xray crashes on that combo).
- **Config builder** (`configBuilder.js`): wraps an outbound into a complete
  runnable client config with two local inbounds — SOCKS on `xraySocksPort`
  (default **10808**) and HTTP on `xrayHttpPort` (default **10809**), both
  bound to `127.0.0.1`.
- **Process lifecycle** (`process.js`): one Xray process = one active outbound.
  `startManagedXray` spawns a detached `xray run -c config.json` child (PID
  file + log), gated by an 8s startup-survival check. `spawnTempXray` runs an
  isolated ephemeral instance for per-config testing without clobbering the
  active proxy. Windows uses `powershell.exe Stop-Process`; Unix uses
  SIGTERM → SIGKILL.
- **Manager** (`manager.js`): orchestration facade + in-memory state machine
  (`stopped → starting → running → error`) that reconciles against the live PID
  to survive Next.js HMR. Exposes start/stop/restart/switch/test/health-check.
- **Sync** (`sync.js`): subscription fetcher + scheduler (initial sync 5s after
  boot, then every `xraySyncIntervalMin`, default 60). Upserts into the
  `xrayConfigs` table; stale configs (dropped from the latest sync) are marked
  inactive.
- **Proxy pool bridge**: the manager creates/syncs a managed proxy pool
  (fixed id `v2go-xray-managed`, `proxyUrl: socks5://127.0.0.1:<socksPort>`,
  flagged `_v2goManaged:true`) so provider connections can egress through the
  V2Ray server like any other pool.
- **Boot** (`src/shared/services/initializeApp.js`): always starts the sync
  scheduler; if `settings.xrayEnabled && settings.xrayAutoStart` and the binary
  is installed, auto-starts the service. `SIGINT/SIGTERM` cleanup stops it.
- **Health probes** (`tester.js`): latency via `gstatic.com/generate_204`
  through a `SocksProxyAgent`; exit-IP via `cloudflare.com/cdn-cgi/trace`;
  raw TCP port probe.
- **API** (`/api/xray/*`): status, start, stop, restart, switch, install, logs,
  health-check, configs (filter by protocol/country/active/healthy),
  `configs/[id]/test`. All lifecycle routes are **local-only** per the guard.
- **Dashboard** (`/dashboard/xray`): binary install/version, SOCKS port, PID,
  latency badge, server table with filters, per-row test/select, subscription
  sync card, live log streamer.

### Web-based/session-based executors

Three executors use session cookies instead of API keys:

- **`grok-web`** (`open-sse/executors/grok-web.js`) — accesses xAI Grok via cookies
- **`perplexity-web`** (`open-sse/executors/perplexity-web.js`) — accesses Perplexity via cookies
- **`gemini-web`** (`open-sse/executors/gemini-web.js`) — accesses Google Gemini via RPC protocol

These share no common base; each implements its own session management within
its executor.

### Gemini-Web cluster

A dedicated subsystem for session/cookie-based access to Gemini via the web
interface (not API), comprising 9 service files + 1 executor:

- `open-sse/executors/gemini-web.js` — executor using the Gemini-Web RPC protocol
- `open-sse/services/geminiWebSession.js` — session management (login, token refresh)
- `open-sse/services/geminiWebCookiePool.js` — multi-account cookie rotation pool
- `open-sse/services/geminiWebCookie.js` — individual cookie lifecycle
- `open-sse/services/geminiWebKeepAlive.js` — keepalive to prevent session expiry
- `open-sse/services/geminiWebFingerprint.js` — browser fingerprint simulation (headers, TLS)
- `open-sse/services/geminiWebRpc.js` — RPC protocol (batchexecute for status, streamgenerate for chat)
- `open-sse/services/geminiWebModels.js` — model listing from web session
- `open-sse/services/geminiWebUsage.js` — usage tracking for web sessions

The executor calls through `geminiWebRpc.js` which uses `batchexecute` (JSON-RPC-style)
for user status checks and `streamgenerate` (binary-framed SSE) for chat completion.
Cookie rotation, keepalive pings, and fingerprint emulation run as background tasks.

## 4. MITM mode (`src/mitm/`)

For IDEs that hardcode their backend domains, 9Router can intercept them
locally instead of being re-pointed at `/v1`:

1. `cert/generate.js` creates a local root CA; `cert/install.js` adds it to
   the OS trust store (Windows/macOS/Linux).
2. `dns/dnsConfig.js` maps target tool domains to `127.0.0.1` via `/etc/hosts`
   (or platform equivalent).
3. `server.js` runs an HTTPS server (SNI + HTTP/2, HTTP/1.1 fallback) that
   terminates TLS with per-domain certs signed by the local CA.
4. Per-IDE handlers (`handlers/{kiro,copilot,antigravity,cursor}.js`) decode
   the intercepted request, map the requested model to a user-configured
   provider model via the `mitmAlias` KV, and forward through the same
   `open-sse` pipeline. (`cursor.js` is a stub returning 501.)
5. `manager.js` owns the child-process lifecycle (auto-restart with backoff,
   port-443 conflict detection), health checks, and DNS teardown. The bundled
   `server.js` is copied to `<DATA_DIR>/runtime/mitm/server.js` at boot so the
   MITM process doesn't lock `node_modules` during `npm i -g` updates.

Intercepted domains (from `src/shared/constants/mitmToolHosts.js`):
Antigravity (`daily-cloudcode-pa.googleapis.com`,
`cloudcode-pa.googleapis.com`), Cursor (`api2.cursor.sh`), Kiro
(`runtime.*.kiro.dev`), Copilot (`api.individual.githubcopilot.com`). The
Antigravity handler also rewrites the IDE `User-Agent`/`metadata.ideVersion`
to `1.23.2` (`antigravityIdeVersion.js`).

## 5. Data & persistence

- **Engine:** SQLite via a runtime-selected driver
  (`src/lib/db/driver.js`): `bun:sqlite` → `better-sqlite3` → `node:sqlite`
  → `sql.js` (WASM). PRAGMAs: WAL, `synchronous=NORMAL`, `mmap_size=30MB`,
  `busy_timeout=5000`, `foreign_keys=ON`.
- **Location:** `<DATA_DIR>/db/data.sqlite`. Default `DATA_DIR`:
  `~/.9router/` (Linux/macOS) or `%APPDATA%/9router/` (Windows).
- **Schema (`SCHEMA_VERSION = 2`), 13 tables:**
  - `_meta` — schema version/migration state, `appVersion`, `totalRequestsLifetime`.
  - `settings` — single-row JSON (auth, password hash, OIDC config, combo/capacity
    strategy, xray/mitm/ds2api/headroom flags, quota visibility, …).
  - `providerConnections` — provider credentials (`authType`: `oauth`/`apikey`/
    `access_token`/`cookie`/`api_key`), priority, isActive; bulk metadata in a
    `data` JSON column (tokens, refresh, `providerSpecificData`, model locks, …);
    multi-account per provider.
  - `providerNodes` — user-defined OpenAI/Anthropic-compatible/embedding
    endpoints (prefix + baseUrl + models).
  - `proxyPools` — outbound proxy pools + rotating groups + test status
    (entries in a `data` JSON column); includes the v2go-managed pool.
  - `apiKeys` — dashboard-issued endpoint API keys (bound to `machineId`).
  - `combos` — multi-model groups (`name` UNIQUE, `kind`, `models` JSON array).
  - `kv` — scoped key-value (`scope,key` PK); scopes: `modelAliases`,
    `customModels`, `mitmAlias`, `pricing`, `disabledModels`.
  - `usageHistory` — per-request tokens/cost/status (indexed by time/provider/
    model/connection); `cost` REAL, `tokens`/`meta` JSON.
  - `usageDaily` — daily aggregates keyed by `dateKey` (`data` JSON).
  - `requestDetails` — full request/response dumps for debugging (`data` JSON).
  - `xrayConfigs` — synced V2Ray share-link catalog (id, link, protocol,
    country, host/port, latency, exit-IP, selected, active). **(v0.6.0)**
  - `xraySyncState` — singleton subscription-sync state (source URL, last sync
    count/error/runs). **(v0.6.0)**
- **Migrations:** versioned files in `src/lib/db/migrations/`
  (`001-initial.js`); `migrate.js` stamps `_meta.schemaVersion` and takes a
  safety backup when `backupSchemaVersion < SCHEMA_VERSION`. `syncSchemaFromTables`
  is an **additive auto-sync** (`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD
  COLUMN` for missing columns) — how schema-v2 tables/columns land without a
  new migration file. Legacy JSON import (`db.json`/usage/disabled/details) is
  a one-time, marker-file-guarded step with row-count assertions.

## 6. Auth & security model

- **Dashboard access:** single admin. Password (bcrypt) or OIDC (PKCE,
  `src/lib/auth/oidc.js`). Sessions are JWT cookies set by
  `dashboardSession.js`. Login is rate-limited per real IP
  (`loginLimiter.js`). Default password is `INITIAL_PASSWORD` (fallback
  `123456`) and remote logins with the default password are forced to change it.
- **Endpoint access:** optional. When `settings.requireApiKey` is true,
  `/api/v1/*` requires a valid bearer / `x-api-key` / `x-goog-api-key` /
  `?key=` from the `apiKeys` table. A "Default Key" is auto-provisioned for
  first-time users so `/v1` works out of the box.
- **Access tiers (`src/dashboardGuard.js`):**
  - `PUBLIC_API_PATHS` — health/init/auth/version + `require-login` setting.
  - `PUBLIC_PREFIXES` — `/v1`, `/v1beta`, `/api/v1`, `/codex` (LLM endpoints,
    API-key auth).
  - `PROTECTED_API_PATHS` — settings/keys/providers/combos/models/usage/oauth/
    pricing/tags/cli-tools/mcp/translator/tunnel/xray status+configs (dashboard
    auth unless `requireLogin === false`).
  - `LOCAL_ONLY_PATHS` — routes that spawn child processes or read host secrets
    (xray lifecycle, MITM, ds2api install/start/stop, tunnel enable/disable,
    cursor/kiro auto-import, headroom start/stop, `auth/reset-password`).
    Allowed via CLI token, OR (loopback Host+Origin AND authenticated). Tunnel
    access additionally requires `settings.tunnelDashboardAccess === true` and
    a known tunnel host.
  - **CLI token** (`x-9r-cli-token`): salted machine-id, trusted for local
    CLI/spawn routes.
- **IP integrity:** `custom-server.js` derives the client IP from the socket
  and strips client-supplied forwarding headers so rate limiting and audit
  can't be spoofed. Requests seen through a reverse proxy are flagged
  (`x-9r-via-proxy`).
- **SSRF guard:** `src/shared/utils/ssrfGuard.js` validates all outbound
  fetch targets, blocking requests to private/internal/metadata IP ranges
  (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, ::1, and cloud metadata
  IPs like 169.254.169.254).
- **Secrets:** env-driven (`.env.example`); `JWT_SECRET`, `INITIAL_PASSWORD`,
  `API_KEY_SECRET`, `MACHINE_ID_SALT` are the security-critical ones. The MITM
  sudo password is encrypted at rest (AES-256-GCM keyed off `node-machine-id`).

## 7. Frontend architecture

- Next.js 16 App Router. Server components fetch data and render shell;
  interactive surfaces are `*Client.js` client components.
- Client state via Zustand (`src/store/`); server data via TTL-cached stores
  and direct `fetch('/api/...')`.
- Real-time: SSE streams for live usage (`/api/usage/stream`), the MCP plugin
  bridge (`/api/mcp/[plugin]/sse`), and the translator console log
  (`/api/translator/console-logs/stream`).
- Runtime i18n (`src/i18n/`) translates the DOM via MutationObserver across
  **35 locales** (dictionaries in `public/i18n/literals/<locale>.json`); theme
  via `useTheme`.

## 8. Deployment & runtime topology

- **Dev:** `npm run dev` → Next on port **20127**.
- **Docker / production:** `node:22-alpine`, CMD `node custom-server.js`,
  exposed port **20128**, volumes `/app/data` and `/app/data-home`
  (→ `/root/.9router`). Multi-arch images (amd64/arm64) published on tag `v*`
  via `.github/workflows/docker-publish.yml` to GHCR + Docker Hub.
- **CLI:** `9router` launches the standalone server (default port **20128**),
  optionally in system-tray mode, and can drive the server over HTTP via
  `cli/src/cli/api/client.js`.
- **Local HTTPS:** `https-server.js` fronts an internal Next server (port
  19997) with self-signed certs on port 9997 for local dev.
- **Tunnels:** Cloudflare Quick Tunnel (`src/lib/tunnel/cloudflare/manager.js`)
  and Tailscale Funnel (`src/lib/tunnel/tailscale/manager.js`) expose the
  dashboard beyond localhost; an `externalTunnelUrl` setting covers tunnels the
  app does not manage. The v2go SOCKS proxy is an **outbound** proxy for
  provider egress, separate from these inbound tunnels.
- **CI (`.github/workflows/`):** `ci.yml` (lint/type/build/audit/dep-check),
  `cli-release.yml` (build + pack CLI tarball on tag `v*`, attaches
  `9router-<ver>.tgz` + stable alias `9router.tgz` to the GitHub Release;
  refuses to build if fork-defining files are missing), `docker-publish.yml`
  (multi-arch build+push on tag, triggers `deploy.yml` via
  `repository_dispatch`), `deploy.yml` (SSH deploy to production),
  `gitbook-pages.yml` (publish the separate `gitbook/` docs site).

## 9. Key extension points (quick reference)

| Want to… | Touch |
|---|---|
| Add an OpenAI-compatible endpoint | `src/app/api/v1/<name>/route.js` + a handler in `src/sse/handlers/` |
| Add an upstream provider | `open-sse/providers/registry/<name>.js` (the single source of truth — self-contained with `display`, `category`, `models`, `authModes`); add an executor in `open-sse/executors/` if the provider needs a non-default transport |
| Add a client format | `open-sse/translator/formats/<name>.js` + `request/`/`response/` (direct routes preferred; OpenAI is the pivot fallback) |
| Change timeouts/retry/backoff | `open-sse/config/runtimeConfig.js`, `config/errorConfig.js` |
| Add a DB table/column | `src/lib/db/schema.js` (`TABLES` object — additive auto-sync handles new tables/columns; bump `SCHEMA_VERSION` + write a versioned migration for destructive changes) |
| Add an MITM-intercepted IDE | `src/mitm/handlers/<ide>.js` + target domain in `src/shared/constants/mitmToolHosts.js` |
| Add dashboard UI | `src/app/(dashboard)/dashboard/<feature>/` + components in `src/shared/components/` |
| Add a token-saver step | insert into the chain in `open-sse/handlers/chatCore.js` (order: RTK → Headroom → Caveman → Ponytail → PXPIPE) |
| Change combo / capacity-adapter defaults | `src/lib/db/repos/settingsRepo.js` (`DEFAULT_SETTINGS`) |
