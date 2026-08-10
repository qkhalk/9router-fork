import { NextResponse } from "next/server";
import { switchConfig } from "@/lib/xray/manager";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (!body.configId) {
      return NextResponse.json({ error: "configId is required" }, { status: 400 });
    }
    const result = await switchConfig(body.configId);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const status =
      error.code === "NOT_FOUND" || error.code === "BAD_CONFIG" ? 400 : error.code === "STARTUP_FAILED" ? 502 : 500;
    return NextResponse.json({ error: error.message, code: error.code || null }, { status });
  }
}
