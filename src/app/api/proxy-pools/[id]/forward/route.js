import { NextResponse } from "next/server";
import { getProxyPoolById } from "@/models";
import { setForwarding, getStatus } from "@/lib/proxy/providers/proxyxoayManager.js";

// GET /api/proxy-pools/[id]/forward — current forwarding state for a proxyxoay pool.
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getProxyPoolById(id);
    if (!existing) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }
    if (existing.type !== "proxyxoay") {
      return NextResponse.json(
        { error: "Only proxyxoay pools support forwarding" },
        { status: 400 }
      );
    }
    const status = await getStatus(id);
    return NextResponse.json({
      forwardEnabled: status?.forwardEnabled ?? false,
      keys: (status?.keys || []).map((k) => ({
        entryId: k.entryId,
        label: k.label,
        forwardPort: k.forwardPort,
        forwardRunning: k.forwardRunning,
      })),
    });
  } catch (error) {
    console.log("Error fetching proxyxoay forward state:", error);
    return NextResponse.json({ error: "Failed to fetch forwarding state" }, { status: 500 });
  }
}

// POST /api/proxy-pools/[id]/forward { enabled: boolean } — start/stop all local
// forwarding servers for the pool's keys.
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getProxyPoolById(id);
    if (!existing) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }
    if (existing.type !== "proxyxoay") {
      return NextResponse.json(
        { error: "Only proxyxoay pools support forwarding" },
        { status: 400 }
      );
    }
    const body = await request.json().catch(() => ({}));
    const enabled = body?.enabled === true;

    const result = await setForwarding(id, enabled);
    if (!result.ok) {
      return NextResponse.json({ error: result.reason || "forwarding update failed" }, { status: 400 });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.log("Error updating proxyxoay forwarding:", error);
    return NextResponse.json({ error: "Failed to update forwarding" }, { status: 500 });
  }
}
