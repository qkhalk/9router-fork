import { NextResponse } from "next/server";
import {
  clearAllModelFilterResults,
  clearModelFilterResultsByModel,
} from "@/lib/localDb";
import { refreshModelFilterCacheStats, isModelFilterRunning } from "@/lib/xray/manager";

export const dynamic = "force-dynamic";

// POST /api/xray/configs/model-filter/clear-cache
// Body: { model?: string }
//   - { model } → clear cache for that model only (used implicitly by force re-test)
//   - no model  → wipe the entire cache
export async function POST(request) {
  try {
    // Refuse to wipe the cache while a filter job is running: in-progress
    // workers would re-write rows they just probed, so the wipe would be
    // silently undone and the "cleared" count would mislead. The client
    // disables the button during runs; this guards direct API calls.
    if (isModelFilterRunning()) {
      return NextResponse.json(
        { error: "A filter run is in progress. Wait for it to finish before clearing the cache." },
        { status: 409 }
      );
    }
    const body = await request.json().catch(() => ({}));
    const model = typeof body.model === "string" ? body.model.trim() : "";
    let cleared;
    if (model) {
      cleared = await clearModelFilterResultsByModel(model);
    } else {
      cleared = await clearAllModelFilterResults();
    }
    // Keep the in-memory cache snapshot in sync so the status badge updates.
    await refreshModelFilterCacheStats().catch(() => {});
    return NextResponse.json({ success: true, cleared, scope: model ? "model" : "all" });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

