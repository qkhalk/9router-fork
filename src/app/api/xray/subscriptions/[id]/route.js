import { NextResponse } from "next/server";
import {
  getXraySubscription,
  updateXraySubscription,
  deleteXraySubscription,
  resolveIntervalMin,
  resolveRetentionDays,
  SubscriptionError,
} from "@/lib/db/repos/subscriptionRepo";
import { getSettings } from "@/lib/db/repos/settingsRepo";
import {
  getConfigIdsWithNoMembership,
  getSubMemberConfigIds,
  deactivateXrayConfigs,
  sweepStaleXrayConfigs,
} from "@/lib/db/repos/xrayRepo";
import { isSubscriptionSyncInFlight, startSyncScheduler } from "@/lib/xray/sync";

export const dynamic = "force-dynamic";

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

export async function PATCH(request, { params }) {
  try {
    const { id } = await params;
    const subId = Number(id);
    if (!Number.isFinite(subId)) return NextResponse.json({ error: "invalid subscription id" }, { status: 400 });

    const existing = await getXraySubscription(subId);
    if (!existing) return NextResponse.json({ error: "subscription not found" }, { status: 404 });

    let body = {};
    try { body = await request.json(); } catch { /* empty patch fine */ }
    const patch = {};
    if (body.name !== undefined) patch.name = typeof body.name === "string" ? body.name : undefined;
    if (body.url !== undefined) patch.url = body.url;
    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
    if (body.intervalMin !== undefined && body.intervalMin !== null && body.intervalMin !== "") {
      patch.intervalMin = clampIntervalMin(body.intervalMin);
    }
    if (body.retentionDays !== undefined && body.retentionDays !== null && body.retentionDays !== "") {
      const retention = validateRetentionDays(body.retentionDays);
      if (retention === null) {
        return NextResponse.json({ error: "retentionDays must be -1, 0, or >= 1" }, { status: 400 });
      }
      patch.retentionDays = retention;
    }

    const updated = await updateXraySubscription(subId, patch);
    const settings = await getSettings();
    startSyncScheduler().catch((e) => console.warn("[XraySync] scheduler restart failed:", e.message));
    return NextResponse.json({
      success: true,
      subscription: {
        ...updated,
        effectiveIntervalMin: resolveIntervalMin(updated, settings.xraySyncIntervalMin),
        effectiveRetentionDays: resolveRetentionDays(updated, settings.xrayStaleRetentionDays),
      },
    });
  } catch (error) {
    if (error instanceof SubscriptionError) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "URL_TAKEN" ? 409 : 400;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const subId = Number(id);
    if (!Number.isFinite(subId)) return NextResponse.json({ error: "invalid subscription id" }, { status: 400 });

    const sub = await getXraySubscription(subId);
    if (!sub) return NextResponse.json({ error: "subscription not found" }, { status: 404 });

    // Zombie-membership guard (RT-13): deleting mid-sync would let the
    // in-flight pipeline re-insert membership rows after the DELETE commits.
    if (isSubscriptionSyncInFlight(subId)) {
      return NextResponse.json({ error: "sync in progress for this subscription" }, { status: 409 });
    }

    // Capture THIS sub's carried configs before the delete so the retention
    // policy applies only to configs orphaned BY THIS DELETE — never to
    // already-unmembered rows (e.g. restored configs stay exempt from
    // sweeping; RT-10/Sec-6 invariant).
    const carried = await getSubMemberConfigIds(subId);
    const removed = await deleteXraySubscription(subId);

    if (removed > 0 && carried.length) {
      const unmembered = new Set(await getConfigIdsWithNoMembership());
      const orphans = carried.filter((id) => unmembered.has(id));
      if (orphans.length) {
        const retention = resolveRetentionDays(sub);
        if (retention === 0) {
          // Delete now: deactivate with an already-past horizon, then sweep
          // once (the sweeper's guards keep this limited to zero-membership,
          // non-tombstoned, inactive rows).
          await deactivateXrayConfigs(orphans, new Date(Date.now() - 1000).toISOString());
          await sweepStaleXrayConfigs(new Date().toISOString());
        } else if (retention > 0) {
          await deactivateXrayConfigs(orphans, new Date(Date.now() + retention * 86400000).toISOString());
        } else {
          // -1 → keep forever: deactivated with no horizon (never swept).
          await deactivateXrayConfigs(orphans, null);
        }
      }
    }

    startSyncScheduler().catch((e) => console.warn("[XraySync] scheduler restart failed:", e.message));
    return NextResponse.json({ success: true, removed });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
