import { NextResponse } from "next/server";
import { listReleasesCached } from "@/lib/xray/versionInfo";

export const dynamic = "force-dynamic";

/**
 * Release picker listing. Drafts are filtered server-side (versionInfo);
 * prereleases are present and flagged so the UI can label them.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const raw = Number(searchParams.get("per_page"));
    const perPage = Number.isFinite(raw) ? Math.min(30, Math.max(1, Math.floor(raw))) : 15;

    const info = await listReleasesCached();
    if (info.error) {
      return NextResponse.json({ releases: [], error: info.error });
    }
    return NextResponse.json({
      releases: info.releases.slice(0, perPage),
      checkedAt: info.checkedAt || new Date().toISOString(),
      ...(info.stale ? { stale: true } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
