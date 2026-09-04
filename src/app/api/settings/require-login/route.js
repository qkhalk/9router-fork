import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";

export async function GET() {
  try {
    const settings = await getSettings();
    // S8: this endpoint is pre-auth — return booleans only, never the tunnel
    // hostnames (they disclose the box's exposure surface to anyone).
    const requireLogin = settings.requireLogin !== false;
    const tunnelDashboardAccess = settings.tunnelDashboardAccess !== false;
    return NextResponse.json({ requireLogin, tunnelDashboardAccess });
  } catch (error) {
    return NextResponse.json({ requireLogin: true }, { status: 200 });
  }
}
