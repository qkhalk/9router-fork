import { NextResponse } from "next/server";
import { sendTestAlert } from "@/lib/alerts";

export const dynamic = "force-dynamic";

// Sends one test alert to a single channel, bypassing dedup (but not the
// channel's own validation). Auth follows the /api/settings family: the
// dashboardGuard middleware protects this path.
export async function POST(request) {
  try {
    const { channel } = await request.json();
    if (!["telegram", "discord", "webhook"].includes(channel)) {
      return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
    }
    const result = await sendTestAlert(channel);
    if (!result.ok) {
      return NextResponse.json({ error: result.error || "Send failed" }, { status: 400 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error sending test alert:", error);
    return NextResponse.json({ error: error?.message || "Failed to send test alert" }, { status: 500 });
  }
}
