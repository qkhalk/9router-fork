# Phase 05 — Alert System (new module src/lib/alerts/)

## Context links

- Audit: §B.1 (Feature 1) + §Feature-design research (Discord/TG rate limits, retry_after semantics) + insertion points from `research/researcher-01-integration-points.md` §5.
- Parent plan: [plan.md](plan.md) (release group B, first phase).
- **Process rules (AGENTS.md):** `impact()` before editing any existing symbol listed in insertion points; `detect_changes()` before commit; new module = greenfield (GitNexus `query()` for context optional).
- Depends on: phase-01 (strict-exhausted signals), phase-02 (TOTU/xray failure branches), phase-08/06/07 emit their events later — this phase ships the module + the events whose sources already exist.

## Overview

Greenfield notification module: `emitAlert(eventType, payload)` fan-out to up to 3 channels (Telegram, Discord, generic webhook) with per-event-type toggles, master on/off, per-event dedup window (default 10 min), and a client-side send queue honoring channel rate limits (Discord ~30/min + 429 Retry-After; TG 1/s per chat + `retry_after`). Settings UI modal (copy TotuAutoFetchModal pattern), test-alert button, i18n. No existing webhook/notification code in repo (verified by researcher grep) — zero collision.

## Key Insights

1. **Event sources already exist** (researcher §5, all verified): all-accounts-locked (chat.js:273-287), proxy-pool-exhausted (connectionProxy.js:217/:231 returns — reshaped by phase-01 into exhausted/error-strict signals), strictproxy-violation (the strictProxy THROW in open-sse/utils/proxyFetch.js:341-352, kept by phase-01 — NOT the connectionProxy.js:217/:231 returns; those are pool-exhausted), xray-node-down (manager.js runHealthCheck :1367, failed probes :614/:1178-1192/:1249), totu-fetch-failed (totuAutoFetch/index.js:209-210, :167-185), quota-near-limit (antigravityQuota.js `quotaCache` :12-16, refreshed at chat.js:499-502/auth.js:86). breaker-open/recovered (phase-06), budget-threshold (phase-08), xray-rotation-failed (phase-07).
2. **Channel limits (researched):** Discord ≈30 msg/min per webhook + 5 req/5s; 429 carries `Retry-After` (seconds). Telegram 30/s global, 1/s per chat; 429 body carries `retry_after`. Both need a client-side queue — coalesce bursts through the dedup window first, then rate-limit sends.
3. **Config idiom (researcher §1):** settings JSON blob + DEFAULT_SETTINGS keys + mergeWithDefaults auto-fill — no migration. UI idiom: per-feature modal (TotuAutoFetchModal at src/app/(dashboard)/dashboard/providers/[id]/TotuAutoFetchModal.js) — copy it. No central settings page exists.
4. **Import-graph safety:** emitAlert is called from hot paths (chat.js) and low-level modules (connectionProxy). alerts module must have ZERO static imports from sse/db layers — read settings via dynamic import (pattern: settings route :145-151 uses dynamic import + `.catch` warn). Alert failure must never fail a user request: fire-and-forget with internal catch.
5. Full event set (user-decided, FINAL): `all-accounts-locked`, `breaker-open`, `breaker-recovered`, `proxy-pool-exhausted`, `strictproxy-violation`, `quota-near-limit`, `budget-threshold`, `xray-node-down`, `xray-rotation-failed`, `totu-fetch-failed`.

## Requirements

- R1: `emitAlert(eventType, payload)` — async-safe, never throws to caller, master gate (`alertsEnabled`), per-event-type toggle, per-event dedup (default 10 min, configurable `alertsDedupMin`).
- R2: Channels — max 1 Telegram (`alertsTelegramBotToken` + `alertsTelegramChatId`), 1 Discord (`alertsDiscordWebhookUrl`, messages use embeds), 1 generic webhook (`alertsWebhookUrl`, POST JSON). Validation on save (settings route sanitize).
- R3: Send queue per channel: Discord 30/min + honor 429 `Retry-After`; TG 1/s per chat + honor `retry_after`; webhook: 5/s cap, simple backoff. Queue survives bursts (in-memory only; document that restart drops queued alerts — acceptable v1).
- R4: Settings UI: modal (copy TotuAutoFetchModal), master toggle, channel fields, per-event-type checkboxes, dedup minutes, per-channel "Send test alert" button.
- R5: i18n keys for all UI strings (follow existing i18n file conventions — locate via existing modal's key usage).
- R6: Generic webhook JSON schema (documented, stable): `{version:1, eventType, timestamp, host, payload}`.
- R7: Emit sites wired for the 6 events whose sources exist now; breaker/budget/rotation events land in their phases (this phase defines the event-type constants).

## Architecture

```
src/lib/alerts/
  index.js        — emitAlert(), EVENT_TYPES, dedup Map, config cache (refreshed per emit via dynamic settings import, 30s TTL)
  queue.js        — per-channel FIFO + rate limiter + 429/retry_after handling + retry w/ backoff (3 tries)
  telegram.js     — sendMessage(text) → api.telegram.org/bot<token>/sendMessage {chat_id, text, parse_mode:"HTML"} (HTML-escape payload)
  discord.js      — POST webhook {embeds:[{title, description, color, timestamp}]} (no content ping)
  webhook.js      — POST alertsWebhookUrl, schema R6, 5s timeout, no redirect follow (SSRF posture: alert URLs are user-configured dashboard-side, still avoid redirects)
```
- Dedup key: `eventType + payload.dedupKey` (callers may pass e.g. provider or poolId) — default payload-level dedup is eventType+primary identifier, time-windowed Map (self-pruning).
- Severity → color/embed styling mapping (info/warn/critical) shared constant.
- No DB writes, no imports above lib layer; everything abortable at master gate before any network I/O.
- Mutex constraint: all emitAlert calls from connectionProxy/proxyFetch run inside auth.js's `selectionMutex` (auth.js:34-40) — emitAlert must be fire-and-forget (internal sync dedup + async queue only), never awaited, or account selection serializes on alert I/O.

## Related code files

| File | Role |
|---|---|
| src/lib/alerts/* (new) | module |
| src/lib/db/repos/settingsRepo.js | DEFAULT_SETTINGS keys (:7-100) + sanitize patterns |
| src/app/api/settings/route.js | PATCH sanitize (:94-101 pattern) + side-effect wiring (:145-151 pattern) |
| src/sse/handlers/chat.js | all-accounts-locked emit (:273-287); strict group-exhausted emit (phase-01 site :422-496) |
| src/lib/network/connectionProxy.js | proxy-pool-exhausted emit on exhausted/error-strict returns (phase-01 signals :217/:231-242) |
| open-sse/utils/proxyFetch.js | strictproxy-violation emit (throw site :341-352) |
| src/lib/xray/manager.js | xray-node-down emit (:1367 runHealthCheck; summary :1249) |
| src/lib/totuAutoFetch/index.js | totu-fetch-failed emit (:209-210, :167-185) |
| src/sse/services/antigravityQuota.js | quota-near-limit emit (cache refresh sites; threshold <20% default) |
| src/app/(dashboard)/dashboard/providers/[id]/TotuAutoFetchModal.js | UI pattern to copy |
| dashboard page for alerts entry (new; e.g. dashboard/alerts/page.js or card on existing dashboard home) | UI |
| i18n files (locate existing) | keys |

## Implementation Steps

1. **Module skeleton** — src/lib/alerts/{index,queue,telegram,discord,webhook}.js per Architecture; EVENT_TYPES constants incl. future events (breaker-open etc.); emitAlert with master gate + dedup; unit tests with fetch mocked.
2. **Settings keys** — DEFAULT_SETTINGS: `alertsEnabled:false`, `alertsTelegramBotToken:""`, `alertsTelegramChatId:""`, `alertsDiscordWebhookUrl:""`, `alertsWebhookUrl:""`, `alertsDedupMin:10`, `alertsQuotaThresholdPct:20`, `alertsEvents:{<eventType>:true}` (per-type map). Settings route sanitize: trim strings, validate webhook URL shape (https), clamp dedup 1-1440.
3. **Queue + senders** — queue.js rate limiters (token bucket: Discord 30/min & 5/5s; TG 1/s per chat; webhook 5/s), 429 `Retry-After`/`retry_after` respect, 3-try backoff, drop-with-log on exhaustion. telegram.js HTML-escapes payload; discord.js embed builder w/ severity colors; webhook.js schema R6 + 5s AbortController timeout + `redirect:"manual"`-equivalent (undici/fetch option).
4. **Emit wiring (6 existing events)** — impact() on each touched symbol first: chat.js allRateLimited branch (:273-287) → all-accounts-locked (dedupKey: provider); connectionProxy strict-exhausted/error-strict returns (phase-01 signals :217/:231-242) → proxy-pool-exhausted (dedupKey: poolId); proxyFetch strictProxy THROW (:341-352, kept by phase-01) → strictproxy-violation (NOT the connectionProxy returns — those are pool-exhausted); xray manager runHealthCheck failure summary (:1249; candidate from :1178-1192/:614) → xray-node-down (dedupKey: node id; THIS phase owns the manager.js emit — phase-07's scheduler does not emit it); totu tick catch (:209-210) + batch result errors (:167-185) → totu-fetch-failed; antigravityQuota refresh path → quota-near-limit when remainingPercentage <= threshold (dedupKey: connectionId+model; natural re-arm at resetAt). **Post-v0.5.65 caveat:** antigravityQuota.js `quotaCache` may contain synthesized 0% entries from upstream's strike-block mechanism (strikeCounts/strikeBlocks, commit ac98dd9d) — the emit MUST distinguish real near-limit reads from strike blocks (e.g., payload flag or skip synthesized entries), else every strike-block fires a misleading "quota near limit" alert.
5. **UI** — alerts modal copying TotuAutoFetchModal (fields, toggles, per-event checkboxes, dedup input); entry point: new dashboard/alerts/page.js (or existing settings-adjacent card — follow where TotuAutoFetch/xray toggles live for discoverability; single decision during impl, keep KISS: standalone page linked from sidebar); test-alert button per channel → POST /api/settings/alerts/test (new route calling sender directly, bypasses dedup, respects queue).
6. **i18n** — add keys for all strings; follow existing namespace conventions.
7. Run `detect_changes()`; suite + new tests; commit.

## Todo list

- [ ] Module skeleton + emitAlert + dedup + master gate (step 1)
- [ ] DEFAULT_SETTINGS keys + route sanitize (step 2)
- [ ] queue.js rate limits + 429/retry_after + backoff (step 3)
- [ ] telegram/discord/webhook senders (+ payload escaping) (step 3)
- [ ] 6 emit sites wired w/ impact() run (step 4)
- [ ] UI modal + dashboard entry + test-alert button + route (step 5)
- [ ] i18n keys (step 6)
- [ ] Tests added; suite 0 pass→fail; detect_changes() clean; committed

## Success Criteria

- Unit tests: dedup window (second emit within window suppressed, after window passes); master gate blocks all I/O; per-type toggle blocks one; TG 429 with `retry_after:2` delays next send ≥2s (fake timers); Discord 429 Retry-After honored; queue drops after 3 failed tries with error log; webhook payload matches schema R6; emitAlert never rejects (all-senders-fail case).
- Integration: manual test-alert arrives in each configured channel (TG + Discord + generic receiver like webhook.site) — recorded in PR.
- Emit-site tests: all-accounts-locked fired exactly once under dedup during a simulated multi-provider outage.
- Full suite green; 0 pass→fail.

## Risk Assessment

| Risk | L×I | Signal it broke | Pre-decided response |
|---|---|---|---|
| Alert sends block/latency-add the chat hot path | M×H | p95 chat latency up after deploy | Fire-and-forget by design (emit returns immediately, queue drains async); test asserts emit <1ms with mocked fetch. If still hot → move emit to setImmediate. |
| Alert storm on cascading outage (all-accounts-locked × providers) | M×M | TG/Discord rate-limit emails; user noise | Dedup window + per-channel queue caps; add global hourly cap (default 50) — pre-decided adjustment if storms observed. |
| Circular import (alerts ← chat.js ← … ) breaks boot | M×H | Boot crash `require cycle` / undefined import | alerts imports NOTHING static from sse/db (dynamic only); lint rule or code-review check; if cycle appears → inline event-const duplication in consumer instead. |
| User pastes internal-URL webhook → SSRF-adjacent exfil/alert-loop | L×M | Webhook pointed at 9router itself causing loops | webhook sender: block requests to own host/localhost/private ranges (reuse phase-04 ssrfGuard helper); 5s timeout. |
| Secrets (bot token) leak via GET /api/settings | M×H | Token visible in settings response | Follow existing strip/mask pattern (password-like handling) — mask on GET, full value only in POST; test asserts masked GET. |

## Security Considerations

- Bot token/webhook URL are credentials: mask in GET responses, never log payloads containing them, never include them in alert payloads.
- Webhook sender blocks private/loopback/own-host targets (SSRF posture) and never follows redirects.
- Discord embeds avoid @everyone content pings; TG parse_mode HTML requires strict escaping (test with `<script>`-ish payload).

## Next steps

- Phase 06 (breaker) and 07 (scheduler) import `emitAlert` + EVENT_TYPES — their events (`breaker-open`, `breaker-recovered`, `xray-rotation-failed`) become active as those phases land; budget-threshold in phase 08.
- Optional later (out of scope): digest emails, per-event channel routing (v1: all channels get all enabled events).
