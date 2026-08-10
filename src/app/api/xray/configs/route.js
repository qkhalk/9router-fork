import { NextResponse } from "next/server";
import { getXrayConfigs, getXrayFacets } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const filter = {
      protocol: searchParams.get("protocol") || undefined,
      country: searchParams.get("country") || undefined,
      isActive: searchParams.get("active") === "1" ? true : searchParams.get("active") === "0" ? false : undefined,
      healthyOnly: searchParams.get("healthy") === "1",
    };
    const [configs, facets] = await Promise.all([getXrayConfigs(filter), getXrayFacets()]);
    return NextResponse.json({ configs, facets });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
