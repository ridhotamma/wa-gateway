# wa-gateway

A standalone WhatsApp gateway: durable notifications, QR pairing, inbound
forwarding, and a small REST API in front of [Baileys](https://github.com/WhiskeySockets/Baileys).

Extracted from the Pesanle monorepo and refactored to run on **Node.js +
[Hono](https://hono.dev/)**. It no longer depends on the monorepo's workspace
packages, Bun runtime, env loader or observability stack.

> Name alternatives considered: `wa-bridge`, `sambung`, `pesanle-wa`,
> `kabel-wa`. `wa-gateway` says what it is: a transport gateway, not a chatbot.

## What it does

- **Pairing** — one Baileys session per tenant slug, QR shown over the API.
- **Durable outbox** — callers enqueue a message and return immediately; the
  gateway sends it when the session is ready, retries transient failures,
  deduplicates by idempotency key, and paces sends per session.
- **Inbound forwarding** — customer messages and attachments are forwarded to
  a webhook (the chatbot lives there, not here).
- **Send receipts** — the final `sent` / `failed` outcome is posted back to the
  caller's status callback.
- **Direct sends** — admin test messages and seller attachments, sharing the
  same hourly send budget as the queue.
- **Media spool** — inbound attachments are written to a short-lived,
  owner-only spool and fetched by the webhook over the authenticated API.

## Requirements

- Node.js **20.19+** (the production image uses Node 22)
- A persistent volume for credentials, one for the outbox and one for media
- One replica only: sessions are in-process sockets

## Quick start

```sh
cp .env.example .env
# set WHATSAPP_API_KEY for anything beyond local development
npm install
npm run dev
```

The gateway starts on `http://localhost:3005`.

```sh
curl http://localhost:3005/health
```

Pair a tenant (`shop` is the session id):

```sh
curl -X POST http://localhost:3005/sessions/shop/start \
  -H "x-api-key: $WHATSAPP_API_KEY"
# -> { "ok": true, "session": { "status": "qr_ready", "qrDataUrl": "data:image/png;base64,…" } }

curl http://localhost:3005/sessions/shop/status \
  -H "x-api-key: $WHATSAPP_API_KEY"
```

Queue a notification:

```sh
curl -X POST http://localhost:3005/notify/text \
  -H "x-api-key: $WHATSAPP_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "sessionId": "shop",
    "phone": "6281234567890",
    "kind": "order.paid",
    "idempotencyKey": "order:123:paid",
    "text": "Pesanan #123 sudah dibayar."
  }'
```

## Architecture

```
src/
  index.ts                     bootstrap: env → services → HTTP → restore → shutdown
  config.ts                    typed, validated environment (fail fast)
  server.ts                    Node HTTP server + graceful stop
  http/
    app.ts                     Hono app, middleware, error mapping
    schemas.ts                 Zod request schemas
    routes/health.ts           public liveness + authenticated inventory
    routes/sessions.ts         pair, status, logout, rename, media download
    routes/notify.ts           queued text / media / buttons
    routes/messages.ts         direct text / media / buttons
    middleware/                auth, request id + structured logging
  services/
    session-manager.ts         lifecycle, restore, typing, session registry
    outbox.ts                  durable queue, pacing, retries, idempotency
    media-store.ts             inbound attachment spool
    inbound-forwarder.ts       customer message → webhook
    status-reporter.ts         sent / failed → webhook
    direct-send.ts             non-queued sends
    typing.ts                  human-looking "typing…"
  engine/
    types.ts                   engine contracts
    errors.ts                  PermanentSendError, UnsafeMediaUrlError
    identity/wa-id.ts          phone / JID normalization
    baileys/                   socket adapter, reconnection, media, buttons
  lib/
    callbacks.ts               webhook URL templates
    logger.ts                  pino
    phone.ts                   log masking
```

### Outbound flow

1. A caller posts to `/notify/*`.
2. The job is written atomically to `pending/<session>/<hash>.json` and the
   API answers `202` with `{ jobId, duplicate }`.
3. The outbox worker sends when the session is `ready`, respecting the
   per-session gap, jitter and hourly cap.
4. Success leaves a PII-free marker in `done/`; permanent failure leaves a
   masked record in `failed/`.
5. `onSettled` posts the outcome to `WHATSAPP_STATUS_URL`.

### Inbound flow

1. Baileys receives a direct customer message.
2. Media bytes are downloaded (up to `WHATSAPP_INBOUND_MEDIA_MAX_BYTES`) and
   written to the media spool.
3. The forwarder posts `{ sessionId, messageId, from, body, timestamp,
hasMedia, media? }` to `WHATSAPP_INBOUND_URL`; the webhook fetches bytes
   from `/sessions/:sessionId/media/:mediaId`.

## API

All routes except public liveness require the shared secret, as
`x-api-key: <key>` or `Authorization: Bearer <key>`.

| Method | Path                           | Purpose                                     |
| ------ | ------------------------------ | ------------------------------------------- |
| GET    | `/health`                      | Liveness; full inventory when authenticated |
| POST   | `/sessions/:id/start`          | Start pairing / return the running session  |
| GET    | `/sessions/:id/status`         | Status, QR data URL, outbox counters        |
| POST   | `/sessions/:id/logout`         | Unlink and remove credentials               |
| POST   | `/sessions/:id/rename`         | Move a session to a new tenant slug         |
| GET    | `/sessions/:id/media/:mediaId` | Fetch a spooled inbound attachment          |
| POST   | `/notify/text`                 | Queue text (202)                            |
| POST   | `/notify/media`                | Queue media + caption (202)                 |
| POST   | `/notify/buttons`              | Queue up to 3 reply buttons (202)           |
| POST   | `/messages/send`               | Direct text send                            |
| POST   | `/messages/send-media`         | Direct media send                           |
| POST   | `/messages/send-buttons`       | Direct reply-button send                    |

Status codes worth handling:

- `202` — queued on disk
- `409 not_connected` — tenant has not linked WhatsApp
- `413` — queued media over 1.5 MB must be a URL
- `422` — permanent send failure (`not_on_whatsapp`, `invalid_recipient`,
  `unsafe_media`)
- `429` — the session's send budget is exhausted; retry later

The request and response shapes are unchanged from the original Pesanle
daemon, so existing clients only need `WHATSAPP_SERVICE_URL` and
`WHATSAPP_API_KEY`.

## Configuration

Every variable is optional unless noted. See [`.env.example`](./.env.example)
for defaults and comments.

| Variable                       | Default                | Notes                                        |
| ------------------------------ | ---------------------- | -------------------------------------------- |
| `NODE_ENV`                     | `development`          | `production` requires `WHATSAPP_API_KEY`     |
| `HOST` / `PORT`                | `0.0.0.0` / `3005`     |                                              |
| `WHATSAPP_LOG_LEVEL`           | `info`                 | pino level                                   |
| `WHATSAPP_API_KEY`             | empty                  | **Required in production**                   |
| `WHATSAPP_AUTH_DIR`            | `./.whatsapp-sessions` | Paired credentials — back up                 |
| `WHATSAPP_OUTBOX_DIR`          | `./.whatsapp-outbox`   | Queued jobs                                  |
| `WHATSAPP_MEDIA_DIR`           | `./.whatsapp-media`    | Inbound attachment spool                     |
| `WHATSAPP_RESTORE`             | `true`                 | Reconnect paired sessions on boot            |
| `WHATSAPP_INBOUND_URL`         | empty                  | Full template or base origin; empty disables |
| `WHATSAPP_STATUS_URL`          | sibling of inbound     | Send outcome callback                        |
| `WHATSAPP_SEND_GAP_MS`         | `3000`                 | Per-session gap between sends                |
| `WHATSAPP_HOURLY_CAP`          | `120`                  | Queue + direct sends per rolling hour        |
| `WHATSAPP_OUTBOX_MAX_ATTEMPTS` | `8`                    | Transient retries before permanent failure   |
| `WHATSAPP_TYPING`              | `true`                 | Human-looking pause for chatbot replies      |

Env loading order: real environment → `.env.local` → `.env`. Real variables
always win; `.env.local` wins over `.env`.

## Operations

### Docker Compose

```sh
cp .env.example .env
# fill WHATSAPP_API_KEY and WHATSAPP_DOMAIN
docker compose up -d --build
docker compose logs -f gateway
```

Caddy obtains and renews TLS for `WHATSAPP_DOMAIN` automatically. The gateway
port is bound to localhost only.

### Backups

`scripts/backup-volumes.sh` snapshots the sessions, outbox and Caddy volumes
and supports off-host upload plus a heartbeat. Losing the sessions volume means
every seller has to scan a new QR code. Run it from cron, e.g. every 6 hours:

```cron
0 */6 * * * /opt/wa-gateway/scripts/backup-volumes.sh >> /var/log/wa-gateway-backup.log 2>&1
```

### Data residency

The host stores live WhatsApp credentials and queued customer phone numbers
and order details. Keep it in the region your privacy policy commits to
(ap-southeast-1 for Pesanle), and treat backups like password files.

### Health

`GET /health` is public and returns only `{ status, uptime }`. Send the API key
to get the instance id, session counts and outbox totals.

## Development

```sh
npm run dev         # tsx watch
npm run typecheck
npm test            # vitest
npm run build       # tsc -> dist/
npm start           # node dist/index.js
npm run format
```

Tests cover the outbox timing/idempotency, media spool, callback URLs, typing,
Baileys protocol helpers, engine close policy, and the HTTP routes.

## Migrating from the monorepo

- The app moved out of `apps/whatsapp`; the engine moved out of
  `packages/whatsapp`.
- `@repo/env` was replaced by Node's `process.loadEnvFile`.
- `@repo/observability` was replaced by structured pino logs on stdout.
  Collect them with your container log pipeline.
- Runtime directories and all `WHATSAPP_*` variable names are unchanged.
