import { NextResponse } from "next/server";
import { syncSubscription } from "@/lib/xray/sync";

export const dynamic = "force-dynamic";

/**
 * Manual sync. Body `{}` (or empty) syncs all ENABLED subscriptions
 * sequentially; `{ subscriptionId }` syncs exactly that sub (manual sync is
 * allowed on disabled subs). Per-sub failures are data in results[] — the
 * run itself only 404s on an unknown id.
 */
export async function POST(request) {
  try {
    let body = {};
    try { body = await request.json(); } catch { /* empty fine */ }

    let subscriptionId;
    if (body.subscriptionId !== undefined && body.subscriptionId !== null && body.subscriptionId !== "") {
      subscriptionId = Number(body.subscriptionId);
      if (!Number.isFinite(subscriptionId)) {
        return NextResponse.json({ error: "subscriptionId must be a number" }, { status: 400 });
      }
    }

    const result = await syncSubscription({ subscriptionId, filterSource: "manual-sync" });
    if (result.unknownSubscriptionId !== undefined) {
      return NextResponse.json({ error: result.error }, { status: 404 });
    }
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
