import { NextResponse } from "next/server";
import { getXrayConfigs, getXrayConfigCounts, getXrayFacets } from "@/lib/localDb";

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
    const facetFilter = {
      isActive: filter.isActive,
    };
    const [configs, facets, counts] = await Promise.all([
      getXrayConfigs(filter),
      getXrayFacets(facetFilter),
      getXrayConfigCounts(),
    ]);
    return NextResponse.json({ configs, facets, counts });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
