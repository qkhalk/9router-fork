import { NextResponse } from "next/server";
import { runModelFilterJob } from "@/lib/xray/manager";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!model) return NextResponse.json({ error: "model is required" }, { status: 400 });

    const all = body.all === true || body.limit === "all";
    const limit = all ? "all" : Math.max(1, Math.min(Number(body.limit) || 50, 500));
    const concurrency = Math.max(1, Math.min(Number(body.concurrency) || 2, 16));
    const pauseOnTraffic = body.pauseOnTraffic !== false;
    const quietMs = Math.max(3000, Math.min(Number(body.quietMs) || 15000, 120000));
    const timeoutMs = Math.max(5000, Math.min(Number(body.timeoutMs) || 20000, 60000));
    const prune = body.prune === true;

    const result = await runModelFilterJob({ model, limit, all, prune, timeoutMs, concurrency, pauseOnTraffic, quietMs, source: "manual" });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const status =
      ["BAD_REQUEST", "BAD_MODEL", "NO_CREDENTIALS", "NOT_INSTALLED"].includes(error.code)
        ? 400
        : 500;
    return NextResponse.json({ error: error.message, code: error.code || null }, { status });
  }
}
