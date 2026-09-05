---
title: Fix fresh-install remote login dead-end with one-time setup code
date: 2026-09-05
summary: "Remote default-password logins were permanently blocked after the CVE-2026-56679 hardening because the client handshake was never updated; added a server-console one-time setup code flow, fixed 3 review-caught security gaps, 21 new tests."
---

# Fix fresh-install remote login dead-end with one-time setup code

## What happened
- Symptom: on a fresh install, logging in remotely with default password 123456 returned 403 "Default password must be changed before remote access..." with no way forward — no form, no self-service.
- Root cause (2 layers): commit ed108262 (CVE-2026-56679 fix) changed the remote default-password login from 200+JWT to 403-no-JWT, but src/app/login/page.js:79-88 only read `mustChangePassword` on `res.ok` — the set-password form became dead code; and the form's PATCH /api/settings fallback required the deliberately-withheld JWT (requireLogin default true), so remote/Docker/VPS first-run had no path at all.
- Fix: server-side one-time setup code (src/lib/auth/setupCode.js; DATA_DIR/setup-code, 0600, timing-safe compare, single-use) printed to the server console; new POST /api/auth/setup-password (fresh-install-gated 404, rate-limited, needs default password + code, rejects default newPassword, never issues a session); login page honors mustChangePassword from the 403 body and shows a setup-code form.
- Code review caught 3 must-fixes, all fixed: (1) recordSuccess on the 403 path reset the shared limiter bucket → setup-code brute-force possible; moved below the mustChange branch. (2) per-attempt console banner enabled unauthenticated log-flood; gated to once/60s. (3) stale setup code survived reset-to-default → leaked code = takeover; clearSetupCode() wired into reset-password route and settings PATCH password set.

## Decision
- Kept the no-JWT-before-rotation invariant; the setup code is host-only knowledge (console + 0600 file), so remote self-service no longer reopens CVE-2026-56679.
- Accepted (review-noted, low impact): non-atomic code mint (self-heals on retry), concurrent claims with the same code (requires host access twice), 32-bit code size (safe with fixed lockout).

## Next steps
- Port the FAQ Q&A to es/ja/zh-CN gitbook languages.
- Consider folding setupCode.js into installSecret.js (maintainer style call).
- Optional: arm the retryAfter countdown after failed auto-login post-setup (cosmetic).

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
