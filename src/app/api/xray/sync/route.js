import { NextResponse } from "next/server";
import { syncSubscription } from "@/lib/xray/sync";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    let body = {};
    try { body = await request.json(); } catch { /* empty fine */ }
    const result = await syncSubscription({ sourceUrl: body.sourceUrl });
    if (result.error) {
      return NextResponse.json({ error: result.error, ...result }, { status: 502 });
    }
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
