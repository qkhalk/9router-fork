import { NextResponse } from "next/server";
import { runTotuFetchOnce } from "@/lib/totuAutoFetch";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// POST /api/providers/totu-ai/fetch-account — trigger a TOTU AI auto-fetch
// batch. Creates up to `maxAccounts` fresh accounts and saves each as a
// 9router provider connection. Never blocks on the full batch: each account
// runs in its own try/catch.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const maxAccounts = body.maxAccounts != null ? Math.floor(Number(body.maxAccounts)) : 3;
    const result = await runTotuFetchOnce(undefined, { maxAccounts });
    return NextResponse.json(result);
  } catch (error) {
    console.log("Error fetching TOTU accounts:", error);
    return NextResponse.json(
      { added: 0, failed: 0, skipped: 0, errors: [{ email: "(batch)", error: error.message }] },
      { status: 500 }
    );
  }
}