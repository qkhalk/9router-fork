import { NextResponse } from "next/server";
import { getStatus } from "@/lib/xray/manager";
import { getXraySyncState } from "@/lib/xray/sync";
import { getSelectedXrayConfig } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [status, syncState] = await Promise.all([Promise.resolve(getStatus()), getXraySyncState()]);
    const activeConfig = status.activeConfigId
      ? await getSelectedXrayConfig().catch(() => null)
      : null;
    return NextResponse.json({ ...status, sync: syncState, activeConfig });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
