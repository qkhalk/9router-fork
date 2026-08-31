# Project Roadmap

> Direction and recent trajectory for the 9Router fork
> (`vibecoder11200/9router`). Current version: **v0.6.33** (2026-09-01),
> tracking upstream through **v0.5.59** (merged 2026-09-01). This is
> a feature-enhanced fork of `decolua/9router`; the fork regularly merges
> upstream while preserving its own additions. Dates are historical where
> stated and indicative otherwise.

## 1. Where we are (v0.6.x)

The fork has matured from a thin upstream mirror into a distinct distribution
with four "own" subsystems on top of the upstream gateway core:

| Subsystem | Shipped | Notes |
|---|---|---|
| **V2Ray proxy (v2go)** | v0.6.0 (2026-08-10) | Managed Xray-core client, SOCKS5/HTTP proxy, v2go subscription sync, auto-rotation. Fixed a SQLite `ORDER BY` regression in v0.6.1. |
| **DeepSeek Web (DS2API) sidecar** | earlier | Local Go sidecar, managed lifecycle, rotating proxy groups, dashboard-driven account/key/queue management. |
| **Rotating proxy pools & groups** | earlier | on-error / round-robin / random rotation, all protocols, per-connection binding, auto-cooldown. |
| **Web-cookie providers** | earlier | Gemini Web (cookie pool), Genspark (MOA + image), Grok Web, Perplexity Web. |

On top of that, the fork tracks upstream's rapid provider/feature cadence. The
recent highlight reel (v0.5.40 → v0.6.1):

- **Capacity adapter** (v0.5.50): default-enabled vision/audio fallback pool
  (default `oc/mimo-v2.5-free`), with auto history-trimming to fit the adapter
  model's context window.
- **New providers**: TokenRouter (300+ models), self-hosted STT/TTS/embedding
  (whisper.cpp, faster-whisper, Kokoro-FastAPI, vLLM, Infinity), Xiaomi MiMo
  TTS, OpenDesign, Poolside, api-airforce, baidu, tencent, sambanova, and more.
  Provider registry now holds **122 definitions** (~40 executors).
- **Qoder dual auth** (v0.5.50): OAuth device flow **and** PAT (Personal
  Access Token) end-to-end, with COSY signing and api2/api3 routing.
- **Codex GPT-5.6** Max/Ultra reasoning-level overrides.
- **Antigravity / Gemini 3.x**: quota tracker shows Gemini 3.6 Flash usage
  bars; retired 3.0 tiers dropped.
- **i18n**: 35 locales (Khmer added).
- **CLI tool integrations**: ~17 tools, MITM interception for Antigravity /
  Copilot / Kiro (Cursor stubbed).

The next arc (v0.6.2 → v0.6.31, 2026-08-10 → 2026-08-21) hardened the v2go
proxy and expanded the provider surface:

- **Model Proxy Filter** (introduced v0.6.5, hardened through v0.6.31): probe
  which Xray configs actually work for a given model; results cached per
  (config, model), single-instance gRPC API mode, and finally model-agnostic
  payloads (no hardcoded `max_tokens`) with time-bounded probes so models
  with upstream token minimums can't fail every config.
- **v2go rotation hardening**: blue-green zero-downtime outbound rotation
  (v0.6.23), proxyxoay pool support + custom rotation interval (v0.6.24),
  flaky-node quarantine and edge-banned exit-IP rotation (v0.6.25–0.6.27).
- **SAML 2.0 SSO** (v0.6.22): dashboard login supports SAML alongside
  password and OIDC.
- **New providers**: Fish Audio TTS, Alibaba Token Plan (`alitp-intl`),
  OrcaRouter, TOTU AI — registry 122 → 126 definitions.
- **Per-account $ balance** for NewAPI gateways (TokenRouter / TOTU AI)
  via the dashboard login token (v0.6.29).
- **TOTU AI account auto-fetch** ("Lấy acc", v0.6.29): mail.tm temp mailbox +
  email OTP + NewAPI register/login, saved as provider connections, with a
  settings-driven scheduler.
- **i18n coverage completed** for all 34 translated locales (v0.6.30).

The latest arc (v0.6.32 → v0.6.33, 2026-08-25 → 2026-09-01) closed the
upstream gap and hardened the opencode executor:

- **opencode anti-fingerprint** (v0.6.32): outbound requests carry the exact
  official opencode CLI fingerprint (full ai-sdk/runtime UA +
  `x-opencode-client: cli`), stopping intermittent `503 Endpoint is
  unavailable` rejections of non-official-looking clients.
- **Upstream merge v0.5.50 → v0.5.59** (v0.6.33): 72 commits — new
  `POST /v1/search` providers (Antigravity grounding, Xquik X-search,
  ollama-search/zai-search credential fallback), Zed plan quota, GLM
  `CREDIT_LIMIT` quotas, `glm-5.3-flash` + DeepSeek V4 Flash Vision (Exp),
  muse-spark via the Responses API, Antigravity quota-aware routing, CLI-tool
  endpoint preset sharing, background model-catalog sync, and the
  better-sqlite3 no-build-tools install for Node 22+. Registry renumbered to
  **124 active definitions** (fork providers moved to p124–p128). Merged with
  zero test regressions; the fork's 30s bounded probes, opencode fingerprint,
  and all four own subsystems preserved.

## 2. Themes guiding the next iterations

These are the directions the recent commit history points to, not promises.

### 2.1 Make "never stop coding" more robust
- **Smarter fallback**: the capacity adapter + combo fusion + proxy-group
  rotation are all relatively new; expect more telemetry and edge-case
  hardening (e.g. the v0.6.1 SQLite fix shows the kind of cross-driver
  portability bugs that surface).
- **Quota maximization**: the quota auto-ping (resets the 5h window for
  Claude/Codex) and per-account usage bars will likely extend to more
  providers.
- **Token savings**: the Headroom "phantom savings" detector and the PXPIPE
  image compressor suggest continued investment in measurable payload
  reduction, not just claimed reduction.

### 2.2 Expand the provider surface
- Keep merging upstream's new providers (the v0.5.59 merge brought xquik +
  ollama-search; 124 active definitions as of v0.6.33 — count via
  `open-sse/providers/registry/index.js`).
- Unblock the three hidden providers (`trae`, `windsurf`, `devin-cli`) once
  tool-calling support lands.
- More self-hosted media (STT/TTS/embedding/image) providers.

### 2.3 Harden the "own" subsystems
- **v2go**: wire the `xrayHealthCheckIntervalMin` setting to an actual
  scheduled health-check (today it's manual/API-triggered only); broaden
  protocol coverage.
- **MITM**: Cursor is stubbed (`501`) — completing it would close the
  last major IDE gap.
- **DS2API**: push loopback-only binding upstream so it's safe on LAN hosts
  without a firewall.

### 2.4 Distribution & reliability
- Keep the GitHub-Releases-only distribution model (the fork does not publish
  to npm); the fork-gate in CI (`cli-release.yml` / `docker-publish.yml`)
  guards against accidental releases missing fork-defining files.
- Continue cross-platform hardening (Windows PowerShell paths, Linux
  `node:sqlite`/`better-sqlite3` parity).

## 3. Recent release history (reference)

| Version | Date | Highlights |
|---|---|---|
| **0.6.33** | 2026-09-01 | Upstream merge v0.5.50 → v0.5.59 (search providers, Zed quota, GLM quotas, new models, muse-spark Responses routing, catalog sync); registry renumbered to 124; zero test regressions. |
| **0.6.32** | 2026-08-25 | opencode anti-fingerprint: official CLI UA + `x-opencode-client: cli` (fixes intermittent 503 "Endpoint is unavailable"). |
| **0.6.31** | 2026-08-21 | Model Proxy Filter: model-agnostic probe payloads (no hardcoded `max_tokens`) + time-bounded probes. |
| **0.6.30** | 2026-08-19 | i18n: dictionary coverage completed for all 34 translated locales; TOTU auto-fetch UI translatable. |
| **0.6.29** | 2026-08-19 | Provider pack: OrcaRouter + TOTU AI providers, TOTU auto-fetch (Lấy acc), per-account $ balance (TokenRouter / TOTU AI), `undici` as direct dependency. |
| **0.6.28** | 2026-08-18 | Usage dashboard hotfix: usage-by-API-key rows kept distinct per key; raw keys no longer leaked in `/api/usage/stats`. |
| **0.6.23** | 2026-08-14 | v2go: blue-green zero-downtime managed-pool rotation, same-exit-IP swap avoidance, drain registry. |
| **0.6.22** | 2026-08-14 | SAML 2.0 SSO; Alibaba Token Plan provider; Kimchi dual auth; Gemini 3.7 Flash on Antigravity. |
| **0.6.1** | 2026-08-10 | Fix: invalid SQLite `ORDER BY` in `getSelectedXrayConfig` (broke v2go proxy start on Linux). |
| **0.6.0** | 2026-08-10 | **V2Ray proxy (v2go)** — managed Xray-core client, subscription sync, SOCKS5/HTTP proxy, auto-rotation. DB schema v2 (`xrayConfigs`, `xraySyncState`). |
| **0.5.50** | 2026-08-05 | Capacity adapter (default-enabled vision/audio), Qoder PAT, TokenRouter, self-hosted STT/TTS/embedding, GPT-5.6 overrides, OpenDesign, endpoint auto-key, headroom savings report, proactive OAuth refresh. Upstream merge v0.5.45 → v0.5.50. Qwen removed. |
| **0.5.45** | 2026-07-30 | Xiaomi MiMo TTS, Poolside/api-airforce/baidu/tencent/sambanova/morph/llm7/kilo-gateway providers, zed/trae/windsurf OAuth, Gemini 3.6 Flash, Claude Opus 5 default, Kimi dual-auth merge. |
| **0.5.40** | 2026-07-20 | Khmer i18n, Grok Build subagent models, Kimi K3/K2.7, ProviderTopology animation. Upstream merge v0.5.35 → v0.5.40. |

See `CHANGELOG.md` for the full history.

## 4. Non-goals (stable)

- 9Router will not become an LLM host or a multi-tenant SaaS. The dashboard
  has a single admin; API keys gate endpoint access, not user identity.
- The fork will not publish to npm — GitHub Releases tarballs + Docker images
  are the distribution channels.
- The v2go SOCKS proxy is an **outbound** egress proxy for provider traffic,
  not an inbound tunnel replacement; Cloudflare/Tailscale remain the inbound
  tunnel story.
