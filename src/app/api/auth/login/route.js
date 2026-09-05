import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { setDashboardAuthCookie } from "@/lib/auth/dashboardSession";
import { isOidcConfigured } from "@/lib/auth/oidc";
import { isSamlConfigured } from "@/lib/auth/saml.js";
import { checkLock, recordFail, recordSuccess, getClientIp } from "@/lib/auth/loginLimiter";
import { isKnownTunnelHost } from "@/lib/auth/tunnelAccess";
import { isLocalRequest } from "@/dashboardGuard";
import { ensureSetupCode } from "@/lib/auth/setupCode";
import { DATA_DIR } from "@/lib/dataDir";
import path from "node:path";

const RESET_HINT = "Forgot password? Reset to default via 9Router CLI → Settings → Reset Password to Default.";
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
// Scanners hammer exposed fresh installs with "123456" around the clock; the
// 3-line banner must not flood docker logs / journald. One print per minute is
// plenty for the operator retrying the login page.
const SETUP_CODE_LOG_INTERVAL_MS = 60_000;
let lastSetupCodeLogAt = 0;

export async function POST(request) {
  try {
    const ip = getClientIp(request);
    const lock = checkLock(ip);
    if (lock.locked) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${lock.retryAfter}s. ${RESET_HINT}`, retryAfter: lock.retryAfter, resetHint: RESET_HINT },
        { status: 429, headers: { "Retry-After": String(lock.retryAfter) } }
      );
    }

    const { password } = await request.json();
    const settings = await getSettings();

    // Block login via tunnel/tailscale if dashboard access is disabled
    if (isKnownTunnelHost(request, settings) && settings.tunnelDashboardAccess !== true) {
      return NextResponse.json({ error: "Dashboard access via tunnel is disabled" }, { status: 403 });
    }

    // Default password is '123456' if not set
    const storedHash = settings.password;

    if (settings.authMode === "sso" || settings.authMode === "saml" || settings.authMode === "oidc") {
      const ssoType = settings.ssoType || (settings.authMode === "saml" ? "saml" : "oidc");
      if (ssoType === "saml" && isSamlConfigured(settings)) {
        return NextResponse.json({ error: "Password login is disabled. Use SAML SSO sign in." }, { status: 403 });
      }
      if (ssoType === "oidc" && isOidcConfigured(settings)) {
        return NextResponse.json({ error: "Password login is disabled. Use OIDC sign in." }, { status: 403 });
      }
    }

    let isValid = false;
    if (storedHash) {
      isValid = await bcrypt.compare(password, storedHash);
    } else {
      // Use env var or default
      const initialPassword = process.env.INITIAL_PASSWORD || "123456";
      isValid = password === initialPassword;
    }

    if (isValid) {
      // Default password still in use on a remote client → force a password
      // change before the dashboard is exposed remotely (keeps local UX intact).
      const mustChangePassword =
        !storedHash && !process.env.INITIAL_PASSWORD && !isLocalRequest(request);

      if (mustChangePassword) {
        // Do NOT issue a session token: a fresh install's default password is
        // public knowledge ("123456"), so handing out a valid JWT would let any
        // remote attacker authenticate and (e.g.) PATCH /api/settings to disable
        // authentication entirely (CVE-2026-56679 class). Require the password
        // to be changed first.
        //
        // Remote self-service goes through POST /api/auth/setup-password, which
        // needs a one-time setup code that only exists on the host (printed to
        // the server console below). Issuing any credential before the default
        // password is rotated would re-open the exact attack chain this branch
        // closes; the setup code is not a credential until host access proves
        // ownership.
        const setupCode = await ensureSetupCode();
        const nowMs = Date.now();
        if (nowMs - lastSetupCodeLogAt > SETUP_CODE_LOG_INTERVAL_MS) {
          lastSetupCodeLogAt = nowMs;
          console.log(
            `[9Router] First remote login on a fresh install: use the one-time setup code ${setupCode}\n` +
            `[9Router] on the login page (with the default password) to set your admin password.\n` +
            `[9Router] The code is also stored at ${path.join(DATA_DIR, "setup-code")} and expires once used.`
          );
        }
        return NextResponse.json(
          { success: false, error: "Default password cannot be used for remote access. Enter the one-time setup code — printed in the server console and saved in the server's data directory (setup-code file) — to set your password.", mustChangePassword, setupRequired: true },
          { status: 403, headers: NO_STORE_HEADERS }
        );
      }

      // Only a login that actually yields a session clears the lockout bucket;
      // a blocked default-password 403 must not reset setup-code guess counts.
      recordSuccess(ip);

      const cookieStore = await cookies();
      await setDashboardAuthCookie(cookieStore, request);

      return NextResponse.json({ success: true, mustChangePassword: false }, { headers: NO_STORE_HEADERS });
    }

    const { remainingBeforeLock } = recordFail(ip);
    const postLock = checkLock(ip);
    if (postLock.locked) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${postLock.retryAfter}s. ${RESET_HINT}`, retryAfter: postLock.retryAfter, resetHint: RESET_HINT },
        { status: 429, headers: { "Retry-After": String(postLock.retryAfter) } }
      );
    }
    return NextResponse.json(
      { error: `Invalid password. ${remainingBeforeLock} attempt(s) left before lockout.`, remainingBeforeLock },
      { status: 401 }
    );
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
