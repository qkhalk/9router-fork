import { NextResponse } from "next/server";
import { getProxyPoolById } from "@/models";
import { getStatus } from "@/lib/proxy/providers/proxyxoayManager.js";

// GET /api/proxy-pools/[id]/status — live runtime snapshot for a proxyxoay pool
// (per-key IP / carrier / location / countdowns / forward ports). Polled by the
// dashboard's proxyxoay control section.
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getProxyPoolById(id);
    if (!existing) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }
    if (existing.type !== "proxyxoay") {
      return NextResponse.json(
        { error: "Only proxyxoay pools expose runtime status" },
        { status: 400 }
      );
    }
    const status = await getStatus(id);
    return NextResponse.json({ status });
  } catch (error) {
    console.log("Error fetching proxyxoay status:", error);
    return NextResponse.json({ error: "Failed to fetch status" }, { status: 500 });
  }
}
