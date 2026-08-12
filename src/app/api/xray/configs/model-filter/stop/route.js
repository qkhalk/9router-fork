import { NextResponse } from "next/server";
import { requestModelFilterCancel, isModelFilterRunning, isModelFilterCancelRequested } from "@/lib/xray/manager";

export const dynamic = "force-dynamic";

// POST /api/xray/configs/model-filter/stop
//
// Requests a cooperative stop of the currently running model-filter job.
// The worker loop checks the cancel flag between configs, so in-flight probes
// finish naturally and the job winds down within a few seconds. Results
// already probed are persisted incrementally (one DB upsert per config), so
// they survive the stop — re-running the filter resumes from where it stopped
// (the cache splitter skips configs with fresh success rows).
//
// This is why no separate "Resume" button is needed: "Run Filter Now" after a
// stop IS the resume.
export async function POST() {
  try {
    if (!isModelFilterRunning()) {
      return NextResponse.json(
        { error: "No filter run is in progress.", running: false },
        { status: 409 }
      );
    }
    // Idempotent: if a stop was already requested, just acknowledge it.
    if (isModelFilterCancelRequested()) {
      return NextResponse.json({ success: true, requested: true, alreadyRequested: true });
    }
    const requested = requestModelFilterCancel();
    return NextResponse.json({
      success: true,
      requested,
      message: "Stop requested. The running filter will wind down after current probes finish.",
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
