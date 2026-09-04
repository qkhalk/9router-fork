# Phase 03 — Core Request Path Fixes (C1-C10, N7-N9)

## Context links

- Audit: `plans/reports/2026-09-03-research-feature-roadmap-and-edge-case-audit.md` §A.3 (C1-C10) + Part D N7-N9 + Partial verdict on C2 (real manifestations: combo fusion + history-media, NOT the capacity-adapter headline).
- Parent plan: [plan.md](plan.md) (release group A).
- **Process rules (AGENTS.md):** GitNexus `impact()` before editing any symbol; `detect_changes()` before commit; HIGH/CRITICAL risk reported to user first. These files are the hottest path in the product (`open-sse/` executors/handlers run for every request).
- **Pre-step (user-flagged) — DECIDED (2026-09-04, verified against upstream tag v0.5.65):** upstream has NO CommandCode peek fix — `open-sse/executors/commandcode.js` is untouched upstream v0.5.59→v0.5.65 → do the LOCAL rewrite (steps 2-4). No cherry-pick candidate exists; the `9R_CC_PEEK_LEGACY=1` escape-hatch decision stands (Risk table).

## Overview

Fix the freshly-merged v0.5.59 regressions and long-lived edge bugs in the request path: CommandCode peek stream rework (C1 + N8 bounded buffering + N9 header whitelist + C8 error replay), per-attempt body isolation for modality stripping (C2), PXPIPE bypass-header gate (C3), deterministic-error no-fallback set (C4), search lock clearing (C5), combo cycle protection (C6), passthrough stream finalization (C7/C9), search body-read timeout (C10), and success-signal honesty (N7).

## Key Insights

1. **C1 root cause verified shape:** `open-sse/executors/commandcode.js:158-196` — on hitting the sentinel line inside a chunk it `break`s the line loop, discarding every complete line after it in the same TCP read. Providers routinely flush sentinel + first deltas in one write → silent prefix truncation. Tests feed one line per chunk (why uncovered). Fix pattern (audit pitfall #4): remaining same-chunk lines become a replayable prefix, never discarded.
2. **N8/C1 same function:** the peek buffers pre-sentinel data with no bound (:134-199) — renamed/unknown event types buffer the entire response in RAM. Bound it; on overflow degrade to pass-through (no stripping) rather than OOM.
3. **C2 (PARTIAL, per red team):** in-place mutation in `stripUnsupportedModalities` (open-sse/translator/concerns/modality.js:61-93, called from chatCore.js:158-168 and chat.js:165-180) is real; manifestations are **combo fusion** (panel members + judge share nested message objects) and **history-media requests** (images in older turns don't reorder fallback order). Fix: per-attempt deep clone before strip (KISS) — clone cost only on the strip path, not all requests.
4. **C4+C6 interplay:** `checkFallbackError` default `shouldFallback:true` (accountFallback.js:48-49) makes deterministic 400s lock every account 30s (chat.js:513-523) and makes combo's `!shouldFallback` branch dead. Fix: explicit no-fallback status set; combo create validates acyclic aliases; chat-side visited-set backstop for legacy data.
5. **N7:** streamingHandler.js:47-53 fires `onRequestSuccess` when the 200 SSE response *starts* — upstream dying at first byte still "heals" modelLock. Move to first forwarded byte. Note ordering with phase-06 breaker: breaker `recordSuccess` must use this same first-byte signal, not headers.
6. **C7/C9 same file:** passthrough forwards `[DONE]` without `finalizeStream()` (stream.js:139, 227-238, 376-407) and flush can emit a second `data: [DONE]` because `streamDoneSent` is translate-mode-only (:400-404).

## Requirements

- R1 (C1): no NDJSON/SSE line is ever dropped due to sentinel position within a chunk; post-sentinel lines replay in order.
- R2 (N8): pre-sentinel buffer capped (default 1 MiB); overflow → passthrough mode with warning log; never unbounded.
- R3 (N9): wrapped SSE Response whitelists headers (content-type, cache-control, x-request-id…); drops stale content-length/content-encoding/transfer-encoding.
- R4 (C8): peek error path returns a body positioned at the replay point (unread prefix restored), not a half-consumed stream.
- R5 (C2): caller's body object never mutated by modality stripping; each attempt sees pristine blocks (combo fusion + history-media covered by tests).
- R6 (C3): PXPIPE respects `X-9Router-Token-Saver: off` exactly like other savers (gate on `tokenSaverEnabled`).
- R7 (C4): deterministic client errors (400/401/402/404/405/413/422) → `shouldFallback:false` (no account locks, no combo member skip); 429/5xx/timeouts keep fallback.
- R8 (C5): /v1/search success clears the scoped `modelLock_websearch:*` and does not stamp account-wide `testStatus:"unavailable"` from search-only failures.
- R9 (C6): combo create rejects alias cycles (self/a→b→a); chat-side visited-set backstop prevents unbounded recursion on legacy rows.
- R10 (C7/C9): passthrough `[DONE]` triggers `finalizeStream` exactly once; no duplicate `[DONE]` frames.
- R11 (C10): chatSearch body read carries the abort signal (headers-received timer extended to body, or dedicated body timeout).
- R12 (N7): `onRequestSuccess` fires on first byte forwarded to the client.

## Architecture

- **CommandCode peek rework (steps 2-4; DECIDED 2026-09-04: local rewrite — upstream v0.5.59→v0.5.65 does not touch commandcode.js)** — internal state machine: `pending` (raw chunk tail), `sentinelFound`, `replayQueue` (lines after sentinel), `buffered` byte count. Consumers: peek loop → returns `{kind:"command"|"passthrough", replayPrefix}`. The wrapped Response (N9) composes `replayPrefix + transform(rest)`.
- **Per-attempt body clone (step 5)** — in chatCore.js/chat.js call sites: `const attemptBody = stripNeeded ? structuredClone(body) : body` before `stripUnsupportedModalities(attemptBody)`. Keep translation pipeline's own per-attempt copy as-is (already correct per red team).
- **Fallback policy (step 7)** — single exported `NO_FALLBACK_STATUSES = new Set([400,401,402,404,405,413,422])` in accountFallback.js; `checkFallbackError` consults it; keep provider-specific overrides intact (verify none of the 40+ executors relies on 400-fallback — impact() on `checkFallbackError`).
- **Combo cycle (step 8)** — create/update route: DFS over alias graph (combos referencing combos), reject cycles with 400; chat resolver: `visited = new Set()` before recursion (backstop).
- **Search unlock (step 9)** — pass `onRequestSuccess` through the destructure in search/index.js:155; ensure the callback invokes `clearAccountError(connectionId, conn, "websearch")`-equivalent so the scoped key matches (auth.js:315-320 clears by model name).

## Related code files

| File | Findings |
|---|---|
| open-sse/executors/commandcode.js | C1 (:158-196), N8 (:134-199), N9 (:312-318), C8 (:200-203) |
| open-sse/handlers/chatCore.js | C2 (:158-168), C3 (:286-296), proxy flow :339-352 |
| open-sse/translator/concerns/modality.js | C2 mutation (:61-93) |
| src/sse/handlers/chat.js | C2 (:165-180), C6 (:196-242), C4 (:513-523) |
| open-sse/services/accountFallback.js | C4 (:48-49) |
| open-sse/handlers/search/index.js | C5 (:155) |
| open-sse/handlers/search.js | C5 (:212-215) |
| src/sse/services/auth.js | C5 clearAccountError model scoping (:306, :315-320) |
| src/app/api/combos/route.js | C6 (:41) |
| open-sse/utils/stream.js | C7 (:139, :227-238, :376-407), C9 (:400-404) |
| open-sse/handlers/search/chatSearch.js | C10 (:501-513) |
| open-sse/handlers/chatCore/streamingHandler.js | N7 (:47-53) |

## Implementation Steps

1. **Upstream check (C1) — DECIDED (2026-09-04, verified against upstream tag v0.5.65):** upstream has NO CommandCode peek fix (file untouched upstream v0.5.59→v0.5.65) → do the LOCAL rewrite (steps 2-4). No search/cherry-pick work remains; record this decision in the PR description.
2. **[C1] commandcode.js peek loop** — replace `break`-discard with replay queue (Architecture). Sentinel found ⇒ remaining complete lines in the SAME buffer are preserved in order and prepended to the outgoing stream.
3. **[N8] bound the peek buffer** — 1 MiB cap on pre-sentinel accumulation; overflow ⇒ abandon stripping, stream buffered data + remainder verbatim (passthrough), warn once per request.
4. **[N9+C8] wrapped Response + error path** — header whitelist on the constructed Response (:312-318), drop content-length/content-encoding; error path (:200-203) returns a stream that replays already-buffered bytes before continuing to read the original body.
5. **[C2] per-attempt clone** — chatCore.js:158-168 and chat.js:165-180: `structuredClone` before strip (only when strip will run); modality.js stays pure-on-its-argument after this (no change needed inside if callers clone — verify by test that caller body is untouched).
6. **[C3] chatCore.js:286-296** — PXPIPE branch: `enabled: tokenSaverEnabled !== false` (match sibling savers' exact gate expression — read neighbors first).
7. **[C4] accountFallback.js** — add `NO_FALLBACK_STATUSES` set + consult in `checkFallbackError` default branch; impact() first (touches every provider's fallback behavior). Add explicit test asserting combo `!shouldFallback` branch is now reachable.
8. **[C6] combos route + chat.js:196-242** — cycle DFS on create/update (400 on cycle); visited-set in the chat-side combo expansion. Handles legacy cyclic rows gracefully (skip + warn, no 500/RangeError).
9. **[C5] search success unlock** — restore `onRequestSuccess` in search/index.js:155 destructure; wire it to clear the scoped lock (auth.js clearAccountError with the search model key used when locking — read search.js:212-215 to get the exact key, likely `websearch`); ensure search failures never stamp account-wide `testStatus:"unavailable"` (scope the mark to the search key).
10. **[C7+C9] stream.js** — passthrough branch: on `[DONE]` forward, call `finalizeStream()` once and set `streamDoneSent` (both modes); flush honors the flag (no duplicate frame).
11. **[C10] chatSearch.js:501-513** — keep the abort timer running through body read (clear only after body consumed) or pass `signal` to the body reader with its own timeout; on timeout → abort upstream, return 504-shape error.
12. **[N7] streamingHandler.js:47-53** — move `onRequestSuccess` invocation to first forwarded chunk (flag set in the transform's first `push`); headers-only success no longer heals modelLock. impact() first — this changes lock-healing timing for ALL providers.
13. Run `detect_changes()` (expect touched flows: chat, search, commandcode provider set); suite + new tests; commit.

## Todo list

- [x] Upstream C1 cherry-pick decision recorded (step 1) — DECIDED 2026-09-04: commandcode.js untouched upstream v0.5.59→v0.5.65 → local rewrite
- [ ] C1 replay-queue peek (step 2)
- [ ] N8 1 MiB buffer cap + passthrough degrade (step 3)
- [ ] N9 header whitelist + C8 error replay (step 4)
- [ ] C2 per-attempt structuredClone (step 5)
- [ ] C3 PXPIPE tokenSaverEnabled gate (step 6)
- [ ] C4 NO_FALLBACK_STATUSES (step 7)
- [ ] C6 combo cycle validation + visited backstop (step 8)
- [ ] C5 search lock clear + scoped failure marks (step 9)
- [ ] C7+C9 passthrough finalize + no dup [DONE] (step 10)
- [ ] C10 search body-read timeout (step 11)
- [ ] N7 first-byte success signal (step 12)
- [ ] Tests added; suite 0 pass→fail; detect_changes() clean; committed

## Success Criteria

- New tests: (a) sentinel + 3 deltas in ONE chunk → all 4 events delivered in order (and a property/fuzz variant — see phase 04 infra — random splits, 1000 iterations); (b) >1 MiB unknown-event stream → passthrough, bounded RSS in test; (c) wrapped Response has no content-length/content-encoding; (d) caller body deep-equal after a failed-then-fallback attempt with images (combo-fusion fixture + history-media fixture); (e) 400 with 3 accounts → zero `markAccountUnavailable` calls; (f) search success → scoped lock cleared (assert key gone); (g) a→b→a combo rejected 400; legacy cycle → skip+warn not 500; (h) passthrough `[DONE]`-then-cancel → usage recorded exactly once, single `[DONE]` frame; (i) stalled search upstream → aborted at timeout.
- CommandCode-provider manual smoke (a real request) per C1/C8.
- Full suite green; 0 pass→fail.

## Risk Assessment

| Risk | L×I | Signal it broke | Pre-decided response |
|---|---|---|---|
| Peek rework regresses ALL CommandCode providers (biggest blast radius in plan) | M×H | CommandCode provider tests fail; user reports truncated/garbled SSE | impact() first; land with fuzz tests; feature-flag escape hatch env (`9R_CC_PEEK_LEGACY=1` → old path) for one release. If fuzz finds unfixable framing issue → stop-and-replan to full rewrite of the wrapper. |
| N7 delays lock-healing → accounts stay locked longer on slow upstreams | M×M | More 503s on flaky providers; modelLock entries lingering | First-byte signal, not stream-end — window is ms. If observed worse → also heal on successful upstream close for non-SSE. |
| C4 no-fallback set breaks a provider that legitimately needs 400-fallback | L×M | Specific provider starts 503ing where it used to recover | Per-provider override map (accountFallback already supports overrides); add exception, document. |
| structuredClone cost on large multimodal bodies | L×M | Latency p95 up on image-heavy chats | Clone only when strip will mutate; measure; if hot → shallow-per-message clone. |
| C5 wrong lock key string → locks still leak | M×M | searchLockKey still present after success in unit assert | Test asserts exact key; read the write-site key generation before writing the clear. |

## Security Considerations

- N8 is a DoS fix (unbounded buffering per request = memory exhaustion vector). Cap must apply before any parse growth.
- N9 prevents response-splitting-style misframing from stale headers on re-encoded streams.
- C10 bounds resource-holding on /v1/search (API-key-reachable).

## Next steps

- N7's first-byte success hook is the exact signal phase-06 breaker consumes (`recordSuccess`) — keep the callback signature stable and note it in phase-06.
- Fuzz harness from Success Criteria (a) gets promoted to shared infra in phase 04 (quality infra item 1).
