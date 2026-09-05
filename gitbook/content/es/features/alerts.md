# Alertas

9Router puede enviar alertas operativas a **Telegram**, **Discord** o cualquier **webhook genérico** cuando algo requiere tu atención — antes de que tu sesión de código se detenga.

El envío es fire-and-forget: nunca bloquea ni ralentiza el manejo de peticiones, y todo el sistema permanece inerte hasta que configuras un canal.

---

## Configuración rápida

```
Dashboard → Alerts

1. Añade un canal (Telegram / Discord / Webhook)
2. Elige los eventos que te interesan (todos ON por defecto)
3. Pulsa "Test" para enviar una alerta de muestra
4. Listo ✅
```

### Telegram

1. Crea un bot con [@BotFather](https://t.me/BotFather) → copia el token del bot
2. Envía cualquier mensaje al bot y obtén tu chat ID (p. ej. con @userinfobot)
3. En Dashboard → Alerts, pega el **Bot Token** + **Chat ID**

### Discord

1. Server Settings → Integrations → Webhooks → **New Webhook**
2. Copia la URL del webhook
3. Pégala en Dashboard → Alerts

Los mensajes llegan como embeds con color: azul = info, naranja = warn, rojo = critical.

### Webhook genérico

Cualquier URL que acepte un POST JSON:

```json
{
  "eventType": "quota-near-limit",
  "severity": "warn",
  "title": "Cuota cerca del límite",
  "body": "Claude Code: 82% usado (se resetea en 2h)",
  "timestamp": "2026-09-05T10:00:00.000Z"
}
```

---

## Eventos de alerta

| Evento | Severidad | Se dispara cuando |
|---|---|---|
| `all-accounts-locked` | critical | Todas las cuentas de un provider están rate-limited — no se pueden servir peticiones |
| `quota-near-limit` | warn | La cuota de un provider cruza el umbral de casi-agotamiento |
| `budget-threshold` | warn | El gasto de una API key cruza su umbral blando (80% por defecto) |
| `breaker-open` | warn | El circuit breaker de una cuenta se abre tras fallos repetidos |
| `breaker-recovered` | info | Un breaker abierto se cierra tras una sonda exitosa |
| `proxy-pool-exhausted` | critical | Todas las entradas de un proxy pool no están disponibles |
| `strictproxy-violation` | critical | El modo strict-proxy habría necesitado conexión directa — petición rechazada |
| `xray-node-down` | critical | El nodo v2go/Xray activo falla su sonda de salud |
| `xray-rotation-failed` | critical | La rotación automática al siguiente nodo Xray falló |
| `totu-fetch-failed` | warn | TOTU auto-fetch no pudo refrescar su suscripción |

Cada tipo de evento se activa/desactiva individualmente.

---

## Cómo funciona el envío

- **Cola por canal** — cada canal tiene su propia cola con pacing; una ráfaga de eventos nunca inunda tu chat ni bloquea nada.
- **Reintentos** — los envíos fallidos reintentan hasta 3 veces con backoff; se respeta `429 Retry-After`.
- **Ventana dedup** — eventos idénticos se deduplican durante 10 minutos (`alertsDedupMin`).
- **Enmascaramiento** — tokens/URLs guardados se enmascaran en la UI; deja un campo vacío para conservar el valor.
- **Fuera del hot path** — la emisión es asíncrona; aunque Telegram caiga, tus peticiones no se ven afectadas.

---

## Relacionado

- [API Keys & Presupuestos](./api-keys.md) - el evento `budget-threshold` viene de los presupuestos por key
- [Circuit Breaker](./circuit-breaker.md) - origen de `breaker-open` / `breaker-recovered`
- [Seguimiento de cuota](./quota-tracking.md) - `quota-near-limit` y el dashboard de Quota
