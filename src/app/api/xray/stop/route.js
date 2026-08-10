import { NextResponse } from "next/server";
import { stopXrayService } from "@/lib/xray/manager";
import { updateSettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await stopXrayService();
    await updateSettings({ xrayEnabled: false });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return NextResponse.json({ error: error.message, code: error.code || null }, { status: 500 });
  }
}
