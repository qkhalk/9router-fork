import { NextResponse } from "next/server";
import { runHealthCheck } from "@/lib/xray/manager";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await runHealthCheck();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
