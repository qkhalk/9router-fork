# Agent C — TOTU AI auto-fetch accounts (Lấy acc) + scheduler + settings UI

Date: 2026-08-18
Worktree: `C:\Users\DORA\Downloads\test\wt-c` (branch `feat/totu-autofetch`, base `60ddc865`)

## Summary

Implemented the TOTU AI account auto-fetch feature end-to-end: a mail.tm temp-inbox
adapter, a NewAPI client for the TOTU register/login/token flow, an orchestrator with
per-account error isolation and an email-dedup check, a scheduler in the quotaAutoPing
pattern, a settings PATCH clamp + live-restart hook, a startup hook, a dashboard
"Lấy acc" button + modal, and a deps-injected unit test.

## Files created

| File | Purpose |
| --- | --- |
| `src/lib/totuAutoFetch/mailtm.js` | mail.tm adapter: `createMailbox`, `getMailTmToken`, `listMessages`, `getMessage`, `waitForVerificationCode` (polls + scans subject/text/html, returns null on timeout, never throws). OTP regex `/\b([A-Za-z0-9]{6})\b/` — handles NewAPI's alphanumeric codes. |
| `src/lib/totuAutoFetch/newapi.js` | NewAPI client: `req` helper (throws on `!res.ok` or `json.success === false`), `login`, `requestVerification`, `register`, `createToken`, `listTokens`, `getTokenKey`, `getSelf`, plus `createTokenAndGetKey` (create → poll list → fetch key). |
| `src/lib/totuAutoFetch/index.js` | Orchestrator `runTotuFetchOnce` (mailbox → OTP → register → login → token → key → dedup → `createProviderConnection`), scheduler `runTotuAutoFetchTick` / `startTotuAutoFetch` / `stopTotuAutoFetch` / `configureTotuAutoFetch` (global `__totuAutoFetch` hot-reload-safe state). |
| `src/app/api/providers/totu-ai/fetch-account/route.js` | POST handler — calls `runTotuFetchOnce()` with default deps, returns `{ added, failed, skipped, errors }`. Static path coexists with the `[id]` dynamic folder (same pattern as `kilo/free-models`). |
| `src/app/(dashboard)/dashboard/providers/[id]/TotuAutoFetchModal.js` | UI modal: enable toggle + interval select (Never/15/30/60) → PATCH `/api/settings`; "Lấy acc ngay" → POST the fetch route → renders `+added / failed / errors`. |
| `tests/unit/totu-autofetch.test.js` | Deps-injected tests: full register→login→token→key→createProviderConnection flow, email dedup skip, per-account error isolation, scheduler start/stop idempotency, tick guard. |

## Files modified

| File | Change |
| --- | --- |
| `src/lib/db/repos/settingsRepo.js` | `DEFAULT_SETTINGS`: `totuAutoFetch: false`, `totuAutoFetchIntervalMin: 60` (next to `xraySyncIntervalMin`). |
| `src/app/api/settings/route.js` | Clamp `totuAutoFetchIntervalMin` (0 = manual-only, else `Math.max(5, Math.floor(raw))`); live-restart hook via `configureTotuAutoFetch(settings)` when `totuAutoFetch`/`totuAutoFetchIntervalMin` change. |
| `src/shared/services/initializeApp.js` | In `runHeavyStartup`, when `settings.totuAutoFetch === true` → `import("@/lib/totuAutoFetch").then(({ startTotuAutoFetch }) => startTotuAutoFetch())`. |
| `src/app/(dashboard)/dashboard/providers/[id]/page.js` | Import + state + "Lấy acc" button (both no-connections and has-connections branches) + modal render, gated on `providerId === "totu-ai"`, reloads connections on success. |

## Notes / verified decisions

- **Provider id**: confirmed the sibling worktree `wt-a` (branch `feat/providers-tokenrouter-totu`)
  registers `totu-ai` (category `apikey`, base `https://totu-ai.com`). My code uses `provider:
  "totu-ai"` and `TOTU_BASE_URL = process.env.TOTU_API_BASE_URL || "https://totu-ai.com"`, so the
  two integrate without touching registry files (out of my ownership).
- **`loginToken` OUT of SAFE_PSD_FIELDS**: `client/route.js`'s `SAFE_PSD_FIELDS` does not include
  `loginToken`, so it is never exposed to the dashboard client. I did NOT modify `client/route.js`.
- **Route placement**: verified static provider routes coexist with the `[id]` dynamic folder
  (`kilo/free-models/route.js`). Used `src/app/api/providers/totu-ai/fetch-account/route.js`.
- **OTP regex**: NewAPI sends a 6-char alphanumeric code (e.g. `8e1b0c`); scans subject → text →
  tag-stripped HTML, preferring subject/text.
- **Login token shape**: implemented a fallback ladder — `data.access_token` →
  `data.token`/`data.session` → top-level `access_token`/`token`/`session` → `session=` cookie from
  `Set-Cookie`. The observed TOTU shape is `data.access_token`.
- **DB deps**: verified `getProviderConnections` and `createProviderConnection` exist in
  `src/lib/localDb.js` (re-exported from `src/lib/db/repos/connectionsRepo.js`). Both accept the
  fields I pass.

## Test + lint status

- `tests/unit/totu-autofetch.test.js`: **8/8 pass** (`npx vitest run unit/totu-autofetch.test.js`).
- ESLint on all owned files: **0 errors, 0 warnings**.
- `page.js` has 3 pre-existing `react-hooks/set-state-in-effect` errors (lines 458/469/873 in base
  `60ddc865`) that I verified exist at HEAD; my additions introduce **no new** lint errors.
- `db-sqlite-vs-lowdb.test.js` fails with a Windows temp-dir EPERM cleanup error at base too —
  unrelated (20/20 tests inside pass).

## Constraints honored

- No version bump, no CHANGELOG edit.
- No `#NNNN`/`org/repo#NNNN` references in commit message.
- No registry/usage/filter/testUtils/models-route/baseline files touched.
- `loginToken` values are runtime values only — never hardcoded in code or git.

Status: DONE
Summary: TOTU auto-fetch (Lấy acc) implemented end-to-end with scheduler + settings UI; unit tests pass, owned files lint clean.
Concerns/Blockers: None blocking. The `totu-ai` provider registry itself ships in the sibling wt-a PR; both land on the same base so the PR will integrate after both merge.
