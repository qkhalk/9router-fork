import { NextResponse } from "next/server";
import { installXrayOrchestrated, isInstallInFlight } from "@/lib/xray/manager";
import { isValidXrayTag } from "@/lib/xray/installer";

export const dynamic = "force-dynamic";

/**
 * Binary install/update. The version tag is strictly validated (RT-1):
 * `installXray` builds the zip + .dgst URLs from it, so a traversal payload
 * must be rejected before any URL construction (the installer re-validates —
 * defense in depth). A previously-running proxy restarts automatically with
 * `.prev` auto-rollback if the restart fails (RT-5).
 */
export async function POST(request) {
  try {
    let body = {};
    try { body = await request.json(); } catch { /* empty body → pinned default */ }

    if (body.version !== undefined && !isValidXrayTag(body.version)) {
      return NextResponse.json(
        { error: `invalid version tag: ${JSON.stringify(body.version)} (expected e.g. "v26.3.27")`, code: "INVALID_VERSION" },
        { status: 400 }
      );
    }

    if (isInstallInFlight()) {
      return NextResponse.json({ error: "an xray install is already in progress", code: "INSTALL_IN_PROGRESS" }, { status: 409 });
    }

    const result = await installXrayOrchestrated({
      version: body.version,
      onProgress: (msg) => {
        // Progress is written to the download log; the UI polls /logs.
      },
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const statusByCode = {
      UNSUPPORTED_PLATFORM: 400,
      UNSUPPORTED_ARCH: 400,
      INVALID_VERSION: 400,
      INSTALL_IN_PROGRESS: 409,
    };
    const status = statusByCode[error.code] || 500;
    return NextResponse.json({ error: error.message, code: error.code || null }, { status });
  }
}
