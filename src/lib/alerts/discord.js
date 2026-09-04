/**
 * Discord sender factory. Posts a single embed (no `content` field, so
 * alerts never @everyone/@here ping anyone). Throws on failure so the
 * SendQueue can retry/drop; 429 responses surface `.retryAfterMs` from the
 * `retry-after` response header (seconds).
 */

import { SEVERITY_COLORS } from "./eventTypes.js";

/**
 * @param {{ getWebhookUrl: () => Promise<string> }} deps
 *   Async getter — settings may not be loaded yet at construction time.
 * @returns {(message: { eventType: string, severity: string, title: string, body: string, host: string, timestamp: string }) => Promise<void>}
 */
export function createDiscordSender({ getWebhookUrl }) {
  return async function discordSend(message) {
    const webhookUrl = await getWebhookUrl();
    if (!webhookUrl) {
      throw new Error("discord not configured");
    }

    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: `[9router] ${message.eventType}`,
            description: `${message.title}\n${message.body}`,
            color: SEVERITY_COLORS[message.severity] ?? SEVERITY_COLORS.warn,
            timestamp: message.timestamp || new Date().toISOString(),
          },
        ],
        // Deliberately NO `content` field — avoids pinging anyone.
      }),
    });

    if (res.status === 429) {
      const retryAfterSec = Number(res.headers && res.headers.get("retry-after")) || 0;
      const err = new Error(`discord 429 rate limited (retry_after=${retryAfterSec}s)`);
      err.retryAfterMs = retryAfterSec * 1000;
      throw err;
    }
    if (!res.ok) {
      throw new Error(`discord send failed: HTTP ${res.status}`);
    }
  };
}
