import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import bcrypt from "bcryptjs";
import { checkLock, recordFail, recordSuccess, getClientIp } from "@/lib/auth/loginLimiter";
import { verifyAndConsumeSetupCode } from "@/lib/auth/setupCode";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const DEFAULT_PASSWORD = "123456";

// First-run remote setup: rotate the fresh-install default password using a
// one-time setup code that only exists on the host (printed to the server
// console by the login route). Never issues a session — the client logs in
// with the new password afterwards. Only exists on a fresh install (no stored
// hash, no INITIAL_PASSWORD); otherwise 404 so it cannot probe install state.
export async function POST(request) {
  try {
    const ip = getClientIp(request);
    const lock = checkLock(ip);
    if (lock.locked) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${lock.retryAfter}s.`, retryAfter: lock.retryAfter },
        { status: 429, headers: NO_STORE_HEADERS }
      );
    }

    const { password, setupCode, newPassword } = await request.json();
    const settings = await getSettings();

    if (settings.password || process.env.INITIAL_PASSWORD) {
      return NextResponse.json({ error: "Not found" }, { status: 404, headers: NO_STORE_HEADERS });
    }

    if (typeof newPassword !== "string" || !newPassword || newPassword === DEFAULT_PASSWORD) {
      return NextResponse.json(
        { error: "New password must not be empty or equal to the default password." },
        { status: 400, headers: NO_STORE_HEADERS }
      );
    }

    if (password !== DEFAULT_PASSWORD || !(await verifyAndConsumeSetupCode(setupCode))) {
      const { remainingBeforeLock } = recordFail(ip);
      return NextResponse.json(
        { error: `Invalid default password or setup code. ${remainingBeforeLock} attempt(s) left before lockout.`, remainingBeforeLock },
        { status: 403, headers: NO_STORE_HEADERS }
      );
    }

    const salt = await bcrypt.genSalt(10);
    await updateSettings({ password: await bcrypt.hash(newPassword, salt) });
    recordSuccess(ip);

    return NextResponse.json({ success: true, mustChangePassword: false }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
