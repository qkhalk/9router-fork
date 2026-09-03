import { NextResponse } from "next/server";
import { ensureOpencodeCatalog, getOpencodeCatalogSnapshot } from "open-sse/providers/opencodeCatalog.js";

export const dynamic = "force-dynamic";

/**
 * Upstream retirement status for OpenCode Free models, from the same api.json
 * catalog the chat routing uses. `synced:false` means the first sync hasn't
 * completed (or failed) — callers must treat every model as unknown, not
 * alive. The await is instant once the catalog is warm.
 */
export async function GET() {
  await ensureOpencodeCatalog();
  return NextResponse.json(getOpencodeCatalogSnapshot());
}
