# Alerts

9Router can push operational alerts to **Telegram**, **Discord**, or any **generic webhook** when something needs your attention — before your coding session grinds to a halt.

Alert delivery is fire-and-forget: it never blocks or slows down request handling, and the whole system is inert until you configure a channel.

---

## Quick Setup

```
Dashboard → Alerts

1. Add a channel (Telegram / Discord / Webhook)
2. Pick the events you care about (all ON by default)
3. Click "Test" to send a sample alert
4. Done ✅
```

### Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) → copy the bot token
2. Send any message to your bot, then get your chat ID (e.g. via @userinfobot)
3. In Dashboard → Alerts, paste **Bot Token** + **Chat ID**

### Discord

1. Server Settings → Integrations → Webhooks → **New Webhook**
2. Copy the webhook URL
3. Paste it in Dashboard → Alerts

Discord messages arrive as color-tinted embeds: blue = info, orange = warn, red = critical.

### Generic Webhook

Any URL that accepts a JSON POST:

```json
{
  "eventType": "quota-near-limit",
  "severity": "warn",
  "title": "Quota near limit",
  "body": "Claude Code: 82% used (resets in 2h)",
  "timestamp": "2026-09-05T10:00:00.000Z"
}
```

---

## Alert Events

| Event | Severity | Fires when |
|---|---|---|
| `all-accounts-locked` | critical | Every account of a provider is rate-limited — requests can't be served |
| `quota-near-limit` | warn | A provider quota crosses the near-limit threshold |
| `budget-threshold` | warn | An API key's spend crosses its soft budget threshold (default 80%) |
| `breaker-open` | warn | A provider account's circuit breaker opens after repeated failures |
| `breaker-recovered` | info | A previously opened breaker closed again after a successful probe |
| `proxy-pool-exhausted` | critical | All entries of a proxy pool are unavailable |
| `strictproxy-violation` | critical | Strict-proxy mode would have needed a direct connection — request refused instead |
| `xray-node-down` | critical | The active v2go/Xray node fails its health probe |
| `xray-rotation-failed` | critical | Auto-rotation to the next Xray node failed |
| `totu-fetch-failed` | warn | TOTU auto-fetch could not refresh its subscription |

Each event type can be toggled individually, so you can silence noisy events while keeping critical ones.

---

## How Delivery Works

- **Per-channel queues** — every channel has its own send queue with pacing, so a burst of events never floods your chat or blocks anything.
- **Retries** — failed sends retry up to 3 times with backoff; upstream `429 Retry-After` headers are respected.
- **Dedup window** — identical events are deduplicated for 10 minutes by default (`alertsDedupMin`), so a flapping node doesn't spam you every few seconds.
- **Credential masking** — saved tokens/webhook URLs are masked in the UI; leave a field blank to keep the stored value.
- **Never on the hot path** — alert emission is async; even if Telegram is down, your requests are unaffected.

---

## Related

- [API Keys & Budgets](./api-keys.md) - `budget-threshold` comes from per-key budgets
- [Circuit Breaker](./circuit-breaker.md) - `breaker-open` / `breaker-recovered` sources
- [Quota Tracking](./quota-tracking.md) - `quota-near-limit` and the Quota dashboard
