import { NextResponse } from "next/server";
import { startXrayService } from "@/lib/xray/manager";
import { updateSettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    let body = {};
    try { body = await request.json(); } catch { /* empty body fine */ }
    const result = await startXrayService({ configId: body.configId });
    if (result.configId) await updateSettings({ xrayEnabled: true });
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
