# 9Router — Project Overview & PDR

> Source of truth for what 9Router is and what it must do. Grounded in the actual
> code in this repository (`9router-mod`). Where older prose docs (README,
> CHANGELOG, gitbook) disagree with the code, the code wins.

## 1. What 9Router is

9Router (`package.json` name: `9router-app`, version `0.6.33`) is a **self-hosted
LLM API gateway / router** with a Next.js dashboard. It exposes an OpenAI-compatible
HTTP API and routes each request to one of many configured upstream providers —
translating between client formats (OpenAI, Claude, Gemini, OpenAI Responses API)
and provider formats on the fly, with streaming (SSE).

It is a **local-first** application: all state lives in a SQLite database on the
host, there is no mandatory cloud dependency, and it ships both a web dashboard
and a CLI (`9router`) for headless use. This checkout (`9router-mod`) is a
**feature-enhanced fork** of `decolua/9router`; the CLI is distributed via
[GitHub Releases](https://github.com/vibecoder11200/9router/releases) tarballs
(**not** the npm registry), and Docker images are published to GHCR + Docker Hub.

### Core capabilities (verified in code)

- **OpenAI-compatible API** under `/api/v1/...`: chat completions, messages
  (Claude), Responses API (Codex), embeddings, images, audio speech/transcriptions,
  video generation, models listing, search, web fetch. Rewrites in
  `next.config.mjs` map `/v1/:path*`, `/v1/v1/:path*`, `/v1beta/:path*`,
  `/codex/:path*`, and `/responses` → `/api/v1/...`.
- **Multi-format translation**: the `open-sse` engine converts between client
  and provider request/response formats, with **direct translator routes**
  (e.g. `claude↔kiro`, `gemini↔openai`, `antigravity↔openai`) preferred and
  OpenAI as the pivot fallback when no direct route exists. Supported source
  formats: `openai`, `openai-responses`, `claude`, `gemini`, `gemini-cli`,
  `gemini-web`, `vertex`, `codex`, `antigravity`, `kiro`, `cursor`, `ollama`,
  `commandcode`.
- **~125 upstream providers** (one self-contained registry file each under
  `open-sse/providers/registry/` — the single source of truth; list the
  directory for the current count), called via specialized executors.
  Three credential
  families: OAuth (Claude, Codex, Gemini-CLI, Antigravity, GitHub Copilot, Kiro,
  Cursor, Kimi, Qoder, GitLab Duo, Cline, CodeBuddy, xAI/Grok, …), API-key
  (OpenAI-compatible gateways like TokenRouter, OpenRouter, DeepSeek, GLM, plus
  Cloudflare AI, self-hosted STT/TTS/embedding, image/video/search providers),
  and web-cookie (Gemini Web, Grok Web, Genspark, Perplexity Web). Three
  providers (`trae`, `windsurf`, `devin-cli`) are registered but hidden pending
  tool-calling support. The NewAPI gateways TokenRouter and TOTU AI support
  **per-account $ balance** queried with the dashboard login token
  (`open-sse/services/usage/newapi.js`; OrcaRouter has no balance API and says
  so), and TOTU AI additionally supports **account auto-fetch**
  (`src/lib/totuAutoFetch/` — see `docs/system-architecture.md`).
- **Credentials & failover**: per-connection credentials (API key, OAuth, or
  cookie), account fallback with exponential backoff + per-model locking, and
  multi-model **combos** (fallback / round-robin / fusion).
- **Capacity adapter**: when a request needs a hard capability (vision, pdf,
  audioInput, videoInput) that the target model/combo lacks, capable pool models
  are prepended as priority candidates (default fallback `oc/mimo-v2.5-free`);
  history is auto-trimmed to fit the adapter model's context window.
  (`open-sse/services/capacityAdapter.js`.)
- **Token saver (RTK + Headroom + Caveman + Ponytail + PXPIPE)**: a fail-open
  pre-translate pipeline that compresses verbose `tool_result` content and
  injects token-frugal system prompts, reporting effective payload savings.
- **MITM mode**: an HTTPS interception proxy (`src/mitm/`) reroutes traffic from
  AI IDEs (Antigravity, Cursor, Kiro, Copilot) through the gateway by installing
  a local root CA and DNS-redirecting tool domains to 127.0.0.1.
- **V2Ray proxy (v2go)**: a managed local **Xray-core** client
  (`src/lib/xray/`) that turns V2Ray share links (VLESS/VMess/Trojan/SS/Hysteria2)
  into a SOCKS5/HTTP proxy 9Router routes through. Auto-syncs ~1,000+ configs
  hourly from the v2go subscription, with per-server latency tests and
  auto-rotation. Exposed as a managed Proxy Pool.
- **Tunnels**: optional Cloudflare Quick Tunnel and Tailscale Funnel integration
  to expose the local dashboard (`src/lib/tunnel/`), plus an "external tunnel
  URL" setting for tunnels the app does not manage.
- **Dashboard**: Next.js App Router UI for providers, combos, usage analytics,
  quota tracker (Gemini 3.x / Antigravity usage bars), MITM config, proxy pools,
  V2Ray proxy, CLI tools, media providers, translator debugger, and settings.
- **CLI**: the `9router` launcher (GitHub Releases tarball) launches/manages the
  standalone server and offers a terminal UI + system-tray mode.
- **SSRF guard**: `ssrfGuard.js` validates outbound fetch targets, blocking
  requests to private/internal/metadata IP ranges to prevent SSRF attacks.

## 2. Tech stack

| Layer | Technology |
|---|---|
| Web framework | Next.js 16 (App Router), React 19.2, standalone output |
| Language | JavaScript (ESM), with `jsconfig.json` path aliases (`@/...`) |
| Styling | Tailwind CSS v4, Material Symbols |
| State (client) | Zustand v5 (`src/store/`), TTL-cached stores |
| Editor / charts / flow | Monaco, Recharts, @xyflow/react, @dnd-kit |
| Auth | bcrypt + JWT dashboard sessions (`src/lib/auth/`), optional OIDC PKCE |
| HTTP | undici, http-proxy-middleware, express (custom server), socks-proxy-agent |
| Database | SQLite via multi-driver adapter (`bun:sqlite` → `better-sqlite3` → `node:sqlite` → `sql.js` WASM fallback), schema v3 |
| Crypto/certs | node-forge, selfsigned, jose (JWT), bcryptjs, node-machine-id |
| V2Ray | bundled Xray-core binary (auto-downloaded per OS/arch into `<DATA_DIR>/xray/`) |

`better-sqlite3` is an `optionalDependency` so install does not fail on hosts
without build toolchains; `sql.js` (WASM) is the runtime fallback. The CLI
deliberately does **not** bundle `better-sqlite3` (to avoid Windows EBUSY during
`npm i -g` updates) and installs it at runtime into `~/.9router/runtime/`.

## 3. Product Development Requirements (PDR)

### 3.1 Goals

1. **One endpoint, any provider.** A client using the OpenAI (or Claude/Gemini)
   API shape must work against 9Router with zero code changes beyond base URL
   and an API key.
2. **Streaming by default.** Chat responses stream as SSE; non-streaming is
   supported but streaming is the primary path.
3. **Local & private.** No data leaves the host except outbound to the chosen
   provider. All config/usage/credentials stored locally in SQLite.
4. **Operationally resilient.** Rate limits, auth failures, and transient errors
   trigger automatic account fallback and retry without manual intervention.
5. **Manageable without a browser.** The CLI can launch the server, manage
   providers/keys/combos, and run headless (system tray).

### 3.2 Non-goals

- 9Router is **not** an LLM itself and does not train or host models.
- It is **not** a multi-tenant SaaS; the dashboard has a single administrative
  user (password / OIDC). API keys gate endpoint access, not user identity.

### 3.3 Functional requirements

| ID | Requirement | Implementation reference |
|---|---|---|
| FR-1 | Expose OpenAI-compatible `/v1/chat/completions` with SSE | `src/app/api/v1/chat/completions/route.js` → `src/sse/handlers/chat.js` → `open-sse/handlers/chatCore.js` |
| FR-2 | Support Claude `/v1/messages`, Gemini, and Responses API formats | `src/app/api/v1/{messages,responses}/`, `open-sse/translator/` |
| FR-3 | Provider connections (API key, OAuth, or cookie), multi-account per provider | `src/lib/db/repos/`, `src/lib/oauth/`, `providerConnections` table |
| FR-4 | Account fallback on 429/401/5xx with backoff + per-model locking | `open-sse/services/accountFallback.js`, `src/sse/services/auth.js` |
| FR-5 | Combos (fallback / round-robin / fusion) across models | `open-sse/services/combo.js`, `combos` table |
| FR-6 | Usage logging + analytics | `usageHistory`, `usageDaily`, `requestDetails` tables; `/api/usage/` |
| FR-7 | MITM rerouting for AI IDEs | `src/mitm/` |
| FR-8 | Tunnel exposure (Cloudflare / Tailscale / external URL) | `src/lib/tunnel/` |
| FR-9 | Dashboard auth (password / OIDC / SAML SSO) with rate-limited login | `src/lib/auth/`, `/api/auth/` |
| FR-10 | CLI launch + terminal UI + tray | `cli/` |
| FR-11 | Web-based/session-based providers (cookie auth, not API key) | `open-sse/executors/gemini-web.js`, `grok-web.js`, `perplexity-web.js`; Gemini-Web cluster (`open-sse/services/geminiWeb*.js`) |
| FR-12 | SSRF guard for outbound requests | `src/shared/utils/ssrfGuard.js` — blocks requests to private/internal/metadata IP ranges |
| FR-13 | DS2API sidecar management (start/stop/status of local DeepSeek-to-API proxy) | `src/lib/ds2api/{detect,process}.js`, `/api/ds2api/*`, `ds2apiEnabled`/`ds2apiUrl` settings |
| FR-14 | Capacity adapter (vision/pdf/audio/video fallback pool) | `open-sse/services/capacityAdapter.js`, `settings.capacityAdapter` |
| FR-15 | V2Ray proxy (managed Xray-core client + v2go subscription sync) | `src/lib/xray/`, `xrayConfigs`/`xraySyncState` tables, `/api/xray/*` |
| FR-16 | Token-saver pipeline (RTK + Headroom + Caveman + Ponytail + PXPIPE) | `open-sse/rtk/`, `open-sse/rtk/headroom.js`, per-request `TOKEN_SAVER_HEADER` opt-out |
| FR-17 | Media generation (image / TTS / STT / video / embedding / search) | `src/app/api/v1/{images,audio,videos,embeddings,search,web}/*`, `open-sse/handlers/{imageGenerationCore,ttsCore,sttCore,embeddingsCore,search}` |
| FR-18 | MCP plugin bridge (preset local stdio plugins → SSE) | `src/lib/mcp/stdioSseBridge.js`, `/api/mcp/[plugin]/{sse,message}` |
| FR-19 | Dashboard SSO (OIDC + SAML 2.0) | `src/lib/auth/oidc.js`, `src/lib/auth/saml.js`, `saml*` settings |
| FR-20 | TOTU AI account auto-fetch (temp mailbox + OTP + scheduler) | `src/lib/totuAutoFetch/`, `totuAutoFetch*` settings, `POST /api/providers/totu-ai/fetch-account` |

### 3.4 Non-functional requirements

- **Portability:** runs on Node 22 (Docker `node:22-alpine`) and Bun; Windows,
  macOS, Linux. DB driver is selected at runtime to avoid native-build failures.
  The CLI requires Node >=18.
- **Security:** login rate-limiting (`loginLimiter.js`), bcrypt password hashing,
  JWT sessions, real-IP injection + spoofable-header stripping in
  `custom-server.js`, optional API-key requirement on the endpoint, SSRF guard
  for outbound fetches (`ssrfGuard.js`), local-only gating for process-spawning
  routes (xray lifecycle, MITM, ds2api install/start/stop, tunnel controls) in
  `src/dashboardGuard.js`.
- **Observability:** in-memory console log buffer (`consoleLogBuffer.js`),
  optional request logging (`ENABLE_REQUEST_LOGS`), request-detail capture,
  opt-in observability export (`OBSERVABILITY_ENABLED`).
- **Configurability:** behavior tunable via env vars (`.env.example`) and the
  single-row `settings` table.

### 3.5 Acceptance criteria (initial docs baseline)

- The four `docs/*.md` files accurately describe the code as it exists today.
- Every architectural claim is traceable to a file path in the repo.
- No claim is copied verbatim from fork-inherited prose without code verification.

## 4. Repository identity

- **Repo/checkout:** `9router-mod` — a modified fork of `decolua/9router`
  (treat inherited prose as unverified; the code wins).
- **Distribution:** CLI/build tarball from
  [GitHub Releases](https://github.com/vibecoder11200/9router/releases) (not
  npm); Docker images at `ghcr.io/vibecoder11200/9router` and
  `vibecoder11200/9router` on Docker Hub (amd64 + arm64).
- **Entrypoints:**
  - Web: `next dev` (port 20127) / `next start`; Docker `node custom-server.js`
    (port 20128).
  - CLI: `cli/cli.js` (built + packed via `cli/scripts/build-cli.js`).
- **Data dir:** `~/.9router/` (Linux/macOS) or `%APPDATA%/9router/` (Windows),
  overridable via `DATA_DIR`. SQLite at `<DATA_DIR>/db/data.sqlite`.

See `docs/system-architecture.md` for how a request flows end-to-end,
`docs/codebase-summary.md` for the directory map, and `docs/code-standards.md`
for conventions.
