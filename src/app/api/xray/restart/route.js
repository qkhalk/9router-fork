import { NextResponse } from "next/server";
import { restartXrayService } from "@/lib/xray/manager";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await restartXrayService();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const status =
      error.code === "NOT_INSTALLED" || error.code === "NO_CONFIG" || error.code === "BAD_CONFIG"
        ? 400
        : error.code === "STARTUP_FAILED"
        ? 502
        : 500;
    return NextResponse.json({ error: error.message, code: error.code || null }, { status });
  }
}
