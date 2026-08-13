/**
 * Boot hook for the proxyxoay manager. Imported for its side effect: registers
 * every active proxyxoay pool from the DB so rotation + forwarding resume after
 * a server restart. Called from src/instrumentation.js (nodejs runtime only),
 * mirroring the initConsoleLogCapture pattern.
 */

import { syncAllFromDb } from "./proxyxoayManager.js";

let started = false;

export async function initProxyXoay() {
  if (started) return;
  started = true;
  try {
    await syncAllFromDb();
  } catch (e) {
    console.warn("[proxyxoay] init failed:", e?.message || e);
  }
}
