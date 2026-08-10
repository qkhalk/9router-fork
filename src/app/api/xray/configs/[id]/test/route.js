import { NextResponse } from "next/server";
import { testSingleConfig } from "@/lib/xray/manager";

export const dynamic = "force-dynamic";

export async function POST(request, { params }) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: "config id required" }, { status: 400 });
    const health = await testSingleConfig(id);
    return NextResponse.json({ success: true, ...health });
  } catch (error) {
    const status =
      error.code === "NOT_FOUND" || error.code === "BAD_CONFIG" || error.code === "NOT_INSTALLED"
        ? 400
        : 500;
    return NextResponse.json({ error: error.message, code: error.code || null }, { status });
  }
}
