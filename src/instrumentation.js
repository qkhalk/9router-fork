export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Resume proxyxoay.org rotation + forwarding servers for active pools.
    const { initProxyXoay } = await import("@/lib/proxy/providers/initProxyXoay.js");
    initProxyXoay();
  }
}
