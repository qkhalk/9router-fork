const DEFAULT_QUIET_MS = 15000;
const DEFAULT_MAX_WAIT_MS = 5 * 60 * 1000;

let lastLiveTrafficAt = 0;
let activeLiveTraffic = 0;

export function recordLiveModelTraffic() {
  lastLiveTrafficAt = Date.now();
}

export function beginLiveModelTraffic() {
  let finished = false;
  activeLiveTraffic += 1;
  recordLiveModelTraffic();

  return () => {
    if (finished) return;
    finished = true;
    activeLiveTraffic = Math.max(0, activeLiveTraffic - 1);
    recordLiveModelTraffic();
  };
}

export function getActiveLiveTrafficCount() {
  return activeLiveTraffic;
}

export function getLiveTrafficQuietForMs(now = Date.now()) {
  if (activeLiveTraffic > 0) return 0;
  return lastLiveTrafficAt > 0 ? now - lastLiveTrafficAt : Infinity;
}

export async function waitForLiveTrafficQuiet({ quietMs = DEFAULT_QUIET_MS, maxWaitMs = DEFAULT_MAX_WAIT_MS } = {}) {
  const startedAt = Date.now();
  while (getLiveTrafficQuietForMs() < quietMs) {
    if (Date.now() - startedAt >= maxWaitMs) {
      return { waitedMs: Date.now() - startedAt, timedOut: true };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { waitedMs: Date.now() - startedAt, timedOut: false };
}

export function wrapLiveModelResponse(response, finish) {
  if (!response || typeof finish !== "function") return response;

  if (!response.body) {
    finish();
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason).catch(() => {});
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
