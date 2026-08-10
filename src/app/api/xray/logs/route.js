import { NextResponse } from "next/server";
import { getXrayLogTail } from "@/lib/xray/manager";
import { getDownloadLogTail } from "@/lib/xray/installer";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const maxLines = Math.min(parseInt(searchParams.get("lines") || "200", 10), 1000);
    const runtime = getXrayLogTail(maxLines);
    const install = getDownloadLogTail(maxLines);
    return NextResponse.json({ runtime, install });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
