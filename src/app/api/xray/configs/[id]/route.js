import { NextResponse } from "next/server";
import {
  deleteXrayConfig,
  restoreXrayConfig,
  hardDeleteXrayConfig,
} from "@/lib/db/repos/xrayRepo";

export const dynamic = "force-dynamic";

async function rawConfigRow(id) {
  const { getAdapter } = await import("@/lib/db/driver.js");
  const db = await getAdapter();
  return db.get(`SELECT id, deletedAt FROM xrayConfigs WHERE id = ?`, [id]);
}

/**
 * Config-level delete semantics (multi-subscription):
 *  - DELETE              → tombstone (soft; sync never resurrects, sweeper
 *                          never eats; restore/hard-delete are explicit)
 *  - DELETE ?permanent=1 → physical delete incl. membership rows
 *  - PATCH {restore:true}→ clear the tombstone
 */
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: "config id required" }, { status: 400 });
    const permanent = new URL(request.url).searchParams.get("permanent") === "1";

    const row = await rawConfigRow(id);
    if (!row) return NextResponse.json({ error: "config not found" }, { status: 404 });

    if (permanent) {
      const removed = await hardDeleteXrayConfig(id);
      // Cascade the model-filter cache too: config ids are content hashes, so
      // a later re-sync of the same link would resurrect the row wearing a
      // stale pass/fail badge (the prune path does the same).
      if (removed) {
        const { deleteModelFilterResultsByConfigIds } = await import("@/lib/db/repos/modelFilterResultsRepo.js");
        await deleteModelFilterResultsByConfigIds([id]).catch(() => {});
      }
      return NextResponse.json({ success: removed, permanent: true });
    }
    if (row.deletedAt) {
      return NextResponse.json({ success: true, tombstoned: true, alreadyTombstoned: true });
    }

    await deleteXrayConfig(id);
    // Keep simple: the proxy keeps running on the (now tombstoned) config
    // until the next switch/restart — selection reads exclude tombstones, so
    // the fallback picks the healthiest remaining active config.
    return NextResponse.json({ success: true, tombstoned: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request, { params }) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: "config id required" }, { status: 400 });

    let body = {};
    try { body = await request.json(); } catch { /* empty body fine */ }
    if (body.restore !== true) {
      return NextResponse.json({ error: "only {restore:true} is supported" }, { status: 400 });
    }

    const restored = await restoreXrayConfig(id);
    if (restored) return NextResponse.json({ success: true, restored: true });

    const row = await rawConfigRow(id);
    if (!row) return NextResponse.json({ error: "config not found" }, { status: 404 });
    return NextResponse.json({ success: true, restored: false, reason: "not-tombstoned" });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
