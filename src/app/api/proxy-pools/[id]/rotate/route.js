import { NextResponse } from "next/server";
import { getProxyPoolById } from "@/models";
import { rotateNow } from "@/lib/proxy/providers/proxyxoayManager.js";

// POST /api/proxy-pools/[id]/rotate — manually rotate one key (entryId) or all
// keys of a proxyxoay pool. Honors the provider rate-limit unless `force` is set.
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const existing = await getProxyPoolById(id);
    if (!existing) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }
    if (existing.type !== "proxyxoay") {
      return NextResponse.json(
        { error: "Only proxyxoay pools support manual rotation" },
        { status: 400 }
      );
    }

    let body = {};
    try {
      body = await request.json();
    } catch {
      /* empty body is fine — rotate all keys */
    }
    const entryId = typeof body?.entryId === "string" && body.entryId ? body.entryId : null;
    const force = body?.force === true;

    const result = await rotateNow(id, entryId, { force });
    const status = result.ok ? 200 : 429;
    return NextResponse.json(result, { status });
  } catch (error) {
    console.log("Error rotating proxyxoay pool:", error);
    return NextResponse.json({ error: "Failed to rotate proxy" }, { status: 500 });
  }
}
