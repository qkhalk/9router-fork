import { NextResponse } from "next/server";
import { FILTERS } from "./filters.js";
import { ensureOpencodeCatalog } from "open-sse/providers/opencodeCatalog.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  const type = searchParams.get("type");

  if (!url || !type) {
    return NextResponse.json({ error: "Missing url or type" }, { status: 400 });
  }

  const filter = FILTERS[type];
  if (!filter) {
    return NextResponse.json({ error: "Unknown filter type" }, { status: 400 });
  }

  // Warm the opencode api.json catalog so deprecated filtering applies on the
  // first request too. The promise never rejects; on failure the filter just
  // fails open (nothing dropped).
  if (type === "opencode-free") await ensureOpencodeCatalog();

  try {
    const res = await fetch(url);
    if (!res.ok) {
      return NextResponse.json({ data: [] });
    }
    const json = await res.json();
    const raw = json.data ?? json.models ?? json;
    const data = filter(Array.isArray(raw) ? raw : []);
    return NextResponse.json({ data });
  } catch {
    return NextResponse.json({ data: [] });
  }
}
