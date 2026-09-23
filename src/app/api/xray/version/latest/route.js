import { NextResponse } from "next/server";
import { getLatestReleaseCached, compareVersions } from "@/lib/xray/versionInfo";
import { getInstalledVersion } from "@/lib/xray/installer";

export const dynamic = "force-dynamic";

/**
 * Stable-latest check for the xray binary. NEVER 5xx for upstream failures —
 * a GitHub outage degrades to `latest = installed, hasUpdate = false, error`.
 */
export async function GET() {
  try {
    const installed = getInstalledVersion();
    const info = await getLatestReleaseCached();

    if (info.error) {
      // No cache, GitHub unreachable: report the installed version honestly.
      return NextResponse.json({
        installed,
        latest: installed,
        hasUpdate: false,
        prerelease: false,
        checkedAt: new Date().toISOString(),
        error: info.error,
      });
    }

    const latest = info.latest;
    const hasUpdate = installed ? compareVersions(latest, installed) > 0 : false;
    return NextResponse.json({
      installed,
      latest,
      hasUpdate,
      prerelease: info.prerelease === true,
      checkedAt: info.checkedAt || new Date().toISOString(),
      ...(info.stale ? { stale: true } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
