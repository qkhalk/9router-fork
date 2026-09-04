# Phase 04 — Security Fixes + Quality Infra (S1-S10, N10-N12, CI, fuzz)

## Context links

- Audit: `plans/reports/2026-09-03-research-feature-roadmap-and-edge-case-audit.md` §A.4 (S1-S10) + Part D N10-N12 + Partials (S3: masking no-op but logger opt-in via `ENABLE_REQUEST_LOGS`, default false).
- Integration research: `research/researcher-01-integration-points.md` §1 (settings blob/mergeWithDefaults — S6), §3 (apiKeys schema/enforcement — S7).
- Parent plan: [plan.md](plan.md) (release group A).
- **Process rules (AGENTS.md):** GitNexus `impact()` before editing any symbol; `detect_changes()` before commit; HIGH/CRITICAL risk reported to user before proceeding.
- **File ownership:** this phase owns src/lib/db/index.js export/import guard logic; phase-02's X12 redaction entry coordinates here.

## Overview

Close the auth-bypass on DB export/import (S1 + N12 + N11), harden the SSRF guard (S2), re-enable secret masking (S3), fix key-at-rest hygiene (S4, S5 + N10, S7, S9, S10), flip the tunnel-dashboard default safely (S6), stop hostname leakage (S8), and land the two quality-infrastructure items from the audit (§B.6): Windows process-lifecycle CI + stream-parser chunk-boundary fuzz tests.

## Key Insights

1. **S1 (CONFIRMED, HIGH):** `src/app/api/settings/database/route.js:9-16` admits JWT *or* CLI token, but `isCliRequest()` (src/dashboardGuard.js:41-48) only checks the `x-9r-cli-token` header is **present** (verified Boolean-header pattern). Any dashboard session adds `x-9r-cli-token: x` → skips password re-auth → full credential dump; `importDb` (src/lib/db/index.js:90-134) writes settings wholesale including the bcrypt hash. Fix = validate the token against the same secret the CLI uses, strip `PROTECTED_SETTING_KEYS` on import, add `Cache-Control: no-store` (N12, route :20).
2. **N11 compounds S1:** `verifyDashboardPassword` (src/dashboardSession.js:75-82) has an `INITIAL_PASSWORD || "123456"` fallback WITHOUT the locality gate the login route has — combined with a stolen session + S1(d) import, remote re-auth reset to a known value. Add the locality gate (localhost/tunnel checks identical to login route).
3. **S6 is the only default-flip in the program:** `tunnelDashboardAccess: true` (settingsRepo.js:32, verified). Flip default to `false` ONLY where the stored raw JSON never explicitly contained the key: `mergeWithDefaults` (settingsRepo.js:129-131) currently spreads defaults under raw — add key-presence check for this one key, then persist the resolved value once so future merges treat it as explicit. UI adds an http:// external-tunnel warning banner.
4. **S7 is THE schema-migration-risk item (user-marked):** apiKeys looked up `WHERE key = ?` (apiKeysRepo.js:41-44; schema.js:78). Hash-at-rest with SHA-256-family + plaintext fallback transition: `validateApiKey` tries `keyHash` first, falls back to legacy plaintext match and lazily backfills the hash. **DECIDED (2026-09-04 user validation): HMAC-SHA256 with per-install secret** — shared `getOrCreateInstallSecret` mechanism with the CLI-token/sudo-key work (R1/R6); no open decision remains.
5. **S5+N10:** sudo-password AES-GCM key = public `machineIdSync()` + hardcoded salt (mitm/manager.js:97-98,154-171), and the `deriveKey()` catch falls back to `sha256(salt)` — every install identical if node-machine-id fails to load (N10, :159-161). Fix: derive from per-install secret (the 0o600 JWT-secret machinery already exists — reuse); on derivation failure, refuse to decrypt (fail-closed), not a public constant.
6. **S2:** `assertPublicUrl` string-matches hostname (ssrfGuard.js:48-56); fetch follows redirects; DNS A-record to private IP works; `100.64.0.0/10` (CGNAT/Tailscale) missing. Fix = resolve DNS (all records), validate every IP against private ranges (RFC1918, loopback, link-local 169.254/16, CGNAT, IPv6 ULA/link-local), `redirect:"manual"` + re-validate each hop (cap 3).

## Requirements

- R1 (S1): export/import requires a VALID CLI token (constant-time compare against per-install secret) or password re-auth; import strips `PROTECTED_SETTING_KEYS` (password hash, sudo blob, JWT-relevant keys — enumerate from dashboardGuard's existing list); GET adds `Cache-Control: no-store` (N12).
- R2 (N11): `verifyDashboardPassword` fallback path gets the login route's locality gate.
- R3 (S2): SSRF guard blocks private-IP DNS results, all redirect hops, and CGNAT range; used by /v1/search caller path (search/callers.js:71-92).
- R4 (S3): requestLogger masks Authorization/cookie/bearer even with `ENABLE_REQUEST_LOGS=true`.
- R5 (S4): MITM dir created 0700, root CA key 0600 (POSIX; Windows documented as ACL-based).
- R6 (S5+N10): sudo-password key derived from per-install secret; derive failure = fail-closed decrypt; ciphertext stripped from `GET /api/settings` (settings/route.js:21 strip list).
- R7 (S6): default false for never-saved installs only; explicit values preserved; http:// externalTunnelUrl warning banner in UI.
- R8 (S7): apiKeys stored hashed (**DECIDED 2026-09-04: HMAC-SHA256 with per-install secret** — shared `getOrCreateInstallSecret` mechanism with CLI-token/sudo-key work); `validateApiKey` hash-first with legacy plaintext fallback + lazy backfill; UI shows only fingerprint/last-4 after migration; **flagged schema-migration-risk**.
- R9 (S8): `/api/settings/require-login` returns booleans only (no tunnel hostnames).
- R10 (S9): `API_KEY_SECRET` derived per-install when unset (apiKey.js:3-18); remove the dead `REQUIRE_API_KEY` env from `.env.example:14,19` (actual toggle is DB setting `requireApiKey`).
- R11 (S10): cloudflared token passed via stdin/env, not argv (cloudflared.js:195-198).
- R12 (Infra): CI windows-latest job (boot → start xray → SIGINT → assert no orphan) + stream-parser fuzz harness in tests.

## Architecture

- **Per-install secret reuse:** one helper (e.g. extend the existing JWT-secret module) `getOrCreateInstallSecret(file, 0o600)`; consumers: CLI-token validation (R1), sudo key (R6), apiKeys HMAC (R8), API_KEY_SECRET fallback (R10). One mechanism, four uses — DRY.
- **S7 transition:** schema adds `keyHash TEXT` (+ keep `key` column). Writes (create key) store hash + masked display value. `validateApiKey`: exact hash hit → ok; else legacy `WHERE key=?` hit → backfill hash, clear plaintext `key` to masked form, ok; else invalid. Migration risk mitigations: run inside a transaction per key; full backup warning in changelog; feature test on a v0.6.33 DB snapshot.
- **SSRF guard:** `assertPublicUrl(url)` → resolve + range-check; new `fetchPublic(url, opts)` wrapper (redirect:"manual", ≤3 hops, re-assert each Location). call-site: search callers path only (impact() to confirm no other consumers break).
- **CI job (.github/workflows/ci.yml — file verified):** `runs-on: windows-latest`, steps: checkout, setup-node, npm ci, boot server (background), trigger xray start via API, taskkill /INT equivalent (send CTRL event or node process kill), assert `tasklist | findstr xray.exe` empty; allowed to fail-soft initially (continue-on-error first 2 weeks) per rollout below.

## Related code files

| File | Findings |
|---|---|
| src/app/api/settings/database/route.js | S1 (:9-16), N12 (:20) |
| src/dashboardGuard.js | S1 (isCliRequest :41-48, :292-296), S6 (:104-112, :236-244) |
| src/lib/db/index.js | S1 (exportDb/importDb :90-134), X12 redaction list |
| src/dashboardSession.js | N11 (:75-82) |
| src/shared/utils/ssrfGuard.js | S2 (:48-56) |
| open-sse/handlers/search/callers.js | S2 consumer (:71-92) |
| open-sse/utils/requestLogger.js | S3 (:72-91, :130-164) |
| src/mitm/cert/rootCA.js | S4 (:88-90) |
| src/mitm/manager.js | S5 (:97-98, :154-171), N10 (:159-161) |
| src/app/api/settings/route.js | S5 strip list (:21) |
| src/lib/db/repos/settingsRepo.js | S6 (:32 default; :129-131 merge) |
| src/lib/db/repos/apiKeysRepo.js + src/lib/db/schema.js:78 | S7 |
| src/app/api/settings/require-login/route.js + tunnelAccess.js:16-28 | S8 |
| src/shared/utils/apiKey.js + .env.example | S9 (:3-18; :14,19) |
| src/lib/tunnel/cloudflared/cloudflared.js | S10 (:195-198) |
| .github/workflows/ci.yml | Infra (verified exists) |
| tests/ (unit dir) | Infra: fuzz harness |

## Implementation Steps

1. **[S1+N12] route guard** — impact() on isCliRequest/exportDb/importDb. `isCliRequest` → validate token: constant-time compare against HMAC(per-install secret) of the token issued by the CLI (read CLI issuance code to match format; if CLI tokens are random strings in DB/settings, compare against that store). Import: strip `PROTECTED_SETTING_KEYS` + `mitmSudoEncrypted` + password hash before writing. GET: `Cache-Control: no-store`.
2. **[N11] dashboardSession.js:75-82** — add locality gate (same helper the login route uses — extract shared `isLocalOrManagedTunnelRequest()` if not already shared).
3. **[S2] ssrfGuard.js + search callers** — implement resolve+range-check+manual-redirect wrapper (Architecture); route /v1/search fetches through it. Unit tests with fixtures: `localhost`, `127.0.0.1`, `10.x`, `192.168.x`, `169.254.169.254`, `100.64.x`, `::1`, `fc00::`, DNS-to-private, redirect-to-private (all must throw).
4. **[S3] requestLogger.js** — restore masking of Authorization/cookie/`bearer ` substrings in both log sinks (:72-91 headers, :130-164 body/redaction); test asserts masked output with ENABLE_REQUEST_LOGS=true.
5. **[S4] rootCA.js:88-90** — `fs.mkdirSync(dir, {recursive:true, mode:0o700})` + `fs.chmodSync(keyPath, 0o600)` after write (guard win32).
6. **[S5+N10] mitm/manager.js** — derive AES key from per-install secret (helper, Architecture); delete the public `sha256(salt)` fallback — on derive failure throw (sudo prompt re-asks instead of decrypting with a universal key); strip ciphertext from GET /api/settings response (:21 list).
7. **[S6] settingsRepo.js mergeWithDefaults + dashboardGuard** — key-presence check for `tunnelDashboardAccess` in raw (absent → false), one-time persist of resolved value; guard paths :104-112/:236-244 already read the setting — no change there. UI: banner on dashboard when `externalTunnelUrl` starts `http://` and tunnel active ("credentials cross in cleartext — set HTTPS or disable").
8. **[S7] apiKeys hash-at-rest (SCHEMA-MIGRATION-RISK)** — per Architecture: `keyHash` column, hash-first validate, lazy backfill transaction, UI fingerprint. impact() on `validateApiKey` + all callers (chat.js:89 and any CLI/middleware callers — enumerate via GitNexus). Test against a snapshot DB from v0.6.33. Changelog: prominent migration note + rollback = restore DB (keys cannot be un-hashed; plaintext dropped only after backfill success).
9. **[S8] require-login route** — response reduced to `{requireLogin: boolean}` (+ existing flags as booleans); hostnames move server-side into guard decisions (tunnelAccess.js:16-28).
10. **[S9] apiKey.js** — default derivation from per-install secret when env unset; update `.env.example` (remove REQUIRE_API_KEY line :14/:19, document behavior). Grep for `API_KEY_SECRET` consumers (checksum logic :3-18) — keep behavior for explicitly-set envs.
11. **[S10] cloudflared.js:195-198** — pass token via stdin (`--token` reads from stdin? verify cloudflared flags: supported via env `TUNNEL_TOKEN` — prefer env; else stdin) — never argv.
12. **[Infra-a] Windows CI job** — add job to .github/workflows/ci.yml per Architecture; `continue-on-error: true` initially, flip to hard after 2 green weeks (pre-decided).
13. **[Infra-b] fuzz harness** — `tests/unit/stream-fuzz.test.js`: random chunk-splits of canned SSE/NDJSON fixtures through commandcode peek + stream.js passthrough; promotes phase-03 fixtures; 1000-iteration property loop with seeded RNG.
14. Run `detect_changes()` (expect: settings/database route, guard, apiKeys flow); full suite; commit (S7 as its own commit for clean revert).

## Todo list

- [ ] S1 CLI-token validation + import strip + export auth path
- [ ] N12 no-store header
- [ ] N11 verifyDashboardPassword locality gate
- [ ] S2 SSRF: DNS resolve + ranges + manual redirects (tests for all fixture classes)
- [ ] S3 requestLogger masking restored
- [ ] S4 rootCA/dir permissions
- [ ] S5+N10 per-install sudo key, fail-closed derive, GET strip
- [ ] S6 default flip w/ explicit-key preservation + http banner
- [ ] S7 apiKeys hash-at-rest + backfill migration (isolated commit)
- [ ] S8 require-login booleans only
- [ ] S9 API_KEY_SECRET per-install + .env.example cleanup
- [ ] S10 cloudflared token off argv
- [ ] Infra-a Windows process-lifecycle CI job (soft-fail rollout)
- [ ] Infra-b stream-parser fuzz harness
- [ ] Suite 0 pass→fail; detect_changes() clean; committed

## Success Criteria

- Tests: SSRF fixture matrix (all blocked); masked logger output; import-with-hash-overwrite attempt → hash unchanged; hash-first validate + backfill (unit + snapshot-DB integration); require-login response contains no hostname strings; CLI-token route rejects `x-9r-cli-token: x` with 401; verifyDashboardPassword fallback refused remotely.
- S6: fresh DB → default false; DB with explicit `true` → stays true (unit test on mergeWithDefaults with both raw shapes).
- CI: windows job green locally via act/manual run before push; fuzz harness deterministic (seeded) and green.
- Full suite green; 0 pass→fail.

## Risk Assessment

| Risk | L×I | Signal it broke | Pre-decided response |
|---|---|---|---|
| **S7 migration locks out API users** (THE flagged item) | L×CRIT | Auth failures spike post-deploy; users report invalid keys | Backfill is lazy+transactional; plaintext kept until hash verified; rollback = revert commit + restore DB snapshot (pre-decided: take DB backup copy step in release runbook). If backfill bug seen → stop-and-replan to write-both-read-hash-only for one release. |
| S1 breaks legitimate CLI export/import flows | M×H | CLI `export`/`import` commands fail with 401 | Coordinate token format with CLI issuance code in same PR; e2e CLI test; adjust compare, not revert. |
| S6 flips tunnel users who DID rely on default-true | M×H | "Dashboard stopped on tunnel" reports | Chelog + banner on tunnel page explaining re-enable; mergeWithDefaults preserves explicit values — only never-saved installs flip. Offer settings one-click re-enable. |
| S5 fail-closed decrypt breaks existing saved sudo passwords | M×M | MITM sudo re-prompt loops | Expected one-time re-entry (old ciphertext undecryptable by design); migrate-on-success: re-encrypt with new key after successful prompt. |
| S2 manual-redirect wrapper breaks legit providers behind redirects | L×M | Search callers fail on 301/302 chains | Allow up to 3 public hops (Architecture); log blocked URLs; per-host allowlist escape hatch if reported. |
| Windows CI flaky (ports/timing) | H×L | CI red noise | continue-on-error rollout (step 12); quarantine with `|| true` + issue, don't block releases. |

## Security Considerations

- Every fix here IS security; two meta-points: (a) all new secrets reuse ONE per-install mechanism (0o600 file) — no new hardcoded salts anywhere; (b) constant-time comparisons for all token/key equality checks added.
- S7 roll call: never log hashes or plaintext keys; UI masks to fingerprint + last-4.
- Export remains a full-credential artifact — no-store + valid-auth + redaction list (loginToken from phase-02 X12 included) are the mitigations; document in README security section.

## Next steps

- Release group A (phases 01-04) completes here → tag (see plan.md note: actual v0.6.35) + CHANGELOG entries: one `## Security` cluster + one `## Fixes` cluster + `## CI` note, following existing bold-title bullet style.
- Phase 05 consumes the per-install-secret helper if alert channels ever need outbound signing (not required v1).
