# Project Roadmap

> Direction and recent trajectory for the 9Router fork
> (`vibecoder11200/9router`). Current version: **v0.6.1** (2026-08-10). This is
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
- Keep merging upstream's new providers (the registry grew from 97 → 122 in a
  few weeks).
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
