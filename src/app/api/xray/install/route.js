import { NextResponse } from "next/server";
import { installXray } from "@/lib/xray/manager";
import { updateSettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    let body = {};
    try { body = await request.json(); } catch { /* empty body is fine */ }
    const result = await installXray({
      version: body.version,
      onProgress: (msg) => {
        // Progress is written to the download log; the UI polls /logs.
      },
    });
    if (result.version) {
      await updateSettings({ xrayVersion: result.version });
    }
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const status = error.code === "UNSUPPORTED_PLATFORM" || error.code === "UNSUPPORTED_ARCH" ? 400 : 500;
    return NextResponse.json({ error: error.message, code: error.code || null }, { status });
  }
}
