import { NextResponse } from "next/server";
import { updateSettings } from "@/lib/localDb";
import { clearSetupCode } from "@/lib/auth/setupCode";

// Reset dashboard password to default by clearing the stored hash.
// Local-only (enforced by dashboardGuard). Never returns the default literal.
export async function POST() {
  try {
    await updateSettings({ password: null });
    // The install is "fresh" again — kill any pending setup code so an old
    // code that leaked into logs/issues cannot claim the default password.
    clearSetupCode();
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
