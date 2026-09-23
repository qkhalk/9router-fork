import { NextResponse } from "next/server";
import { getStatus } from "@/lib/xray/manager";
import { listXraySubscriptions } from "@/lib/db/repos/subscriptionRepo";
import { getSelectedXrayConfig } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // RT-15: `sync` is a SUB-AGNOSTIC aggregate — under multi-subscription a
    // per-sub sourceUrl/lastSyncError would misattribute one sub's state to
    // the whole feature. Per-sub truth lives in GET /api/xray/subscriptions.
    const [status, subscriptions] = await Promise.all([
      Promise.resolve(getStatus()),
      listXraySubscriptions().catch(() => []),
    ]);
    const synced = subscriptions.filter((s) => s.lastSyncAt);
    const lastSyncAt = synced.length
      ? synced.map((s) => s.lastSyncAt).sort().at(-1)
      : null;
    const failingSubs = subscriptions.filter((s) => s.lastSyncError).length;
    const sync = { lastSyncAt, totalSubs: subscriptions.length, failingSubs };

    const activeConfig = status.activeConfigId
      ? await getSelectedXrayConfig().catch(() => null)
      : null;
    return NextResponse.json({ ...status, sync, activeConfig });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
