import { NextResponse } from "next/server";
import {
  listXraySubscriptions,
  createXraySubscription,
  SubscriptionError,
} from "@/lib/db/repos/subscriptionRepo";
import { getSettings } from "@/lib/db/repos/settingsRepo";
import {
  resolveIntervalMin,
  resolveRetentionDays,
} from "@/lib/db/repos/subscriptionRepo";
import { startSyncScheduler } from "@/lib/xray/sync";

export const dynamic = "force-dynamic";

// intervalMin: 0 = manual-only; positives clamp to 5..20160 (RT-11 overflow
// guard). retentionDays: -1 keep-forever, 0 delete-on-loss, N days.
function clampIntervalMin(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(20160, Math.max(5, Math.floor(n)));
}

function validateRetentionDays(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n)) return null;
  if (n === -1 || n === 0 || n >= 1) return n;
  return null;
}

/** Attach resolved effective interval/retention for UI display. */
async function withEffective(subs) {
  const settings = await getSettings();
  return subs.map((s) => ({
    ...s,
    effectiveIntervalMin: resolveIntervalMin(s, settings.xraySyncIntervalMin),
    effectiveRetentionDays: resolveRetentionDays(s, settings.xrayStaleRetentionDays),
  }));
}

export async function GET() {
  try {
    const subscriptions = await withEffective(await listXraySubscriptions());
    return NextResponse.json({ subscriptions });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    let body = {};
    try { body = await request.json(); } catch { /* empty body → validation 400 */ }

    if (!body.url || typeof body.url !== "string") {
      return NextResponse.json({ error: "url is required" }, { status: 400 });
    }
    const patch = {
      name: typeof body.name === "string" ? body.name : undefined,
      url: body.url,
      enabled: body.enabled !== false,
    };
    if (body.intervalMin !== undefined && body.intervalMin !== null && body.intervalMin !== "") {
      patch.intervalMin = clampIntervalMin(body.intervalMin); // clamped silently
    }
    if (body.retentionDays !== undefined && body.retentionDays !== null && body.retentionDays !== "") {
      const retention = validateRetentionDays(body.retentionDays);
      if (retention === null) {
        return NextResponse.json({ error: "retentionDays must be -1, 0, or >= 1" }, { status: 400 });
      }
      patch.retentionDays = retention;
    }

    const created = await createXraySubscription(patch);
    startSyncScheduler().catch((e) => console.warn("[XraySync] scheduler restart failed:", e.message));
    return NextResponse.json({ success: true, subscription: await withEffective([created]).then((a) => a[0]) }, { status: 201 });
  } catch (error) {
    if (error instanceof SubscriptionError) {
      const status = error.code === "URL_TAKEN" ? 409 : 400;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
