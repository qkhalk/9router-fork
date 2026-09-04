import { NextResponse } from "next/server";
import { resetBreaker } from "@/sse/services/circuitBreaker.js";

export const dynamic = "force-dynamic";

// POST /api/providers/[id]/breaker - manually reset an account's circuit
// breaker (dashboard panel button). Same guard surface as sibling provider
// mutations on this route tree (dashboard auth middleware).
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "Connection id is required" }, { status: 400 });
    }
    const reset = resetBreaker(id);
    return NextResponse.json({ ok: true, reset });
  } catch (error) {
    console.log("Error resetting breaker:", error);
    return NextResponse.json({ error: "Failed to reset breaker" }, { status: 500 });
  }
}
