// Tunnel-host detection shared by the dashboard guard and login route.
// A request counts as "from a known tunnel" when its Host header matches one of
// the configured tunnel URLs. externalTunnelUrl covers tunnels the app does not
// manage itself (e.g. a cloudflared service run via systemd), which never write
// tunnelUrl into settings.

function hostFromUrl(url) {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isKnownTunnelHost(request, settings) {
  if (!settings) return false;
  const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
  if (!host) return false;

  const candidates = [
    hostFromUrl(settings.tunnelUrl),
    hostFromUrl(settings.tailscaleUrl),
    hostFromUrl(settings.externalTunnelUrl),
  ].filter(Boolean);

  return candidates.includes(host);
}
