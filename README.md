# wa-gateway

[![CI](https://github.com/ridhotamma/wa-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/ridhotamma/wa-gateway/actions/workflows/ci.yml)
[![Docker](https://github.com/ridhotamma/wa-gateway/actions/workflows/docker.yml/badge.svg)](https://github.com/ridhotamma/wa-gateway/actions/workflows/docker.yml)

Self-hosted WhatsApp gateway with QR pairing, a durable SQLite outbox,
inbound/status webhooks, a REST API and an admin console.

Built with Node.js 22, [Baileys](https://github.com/WhiskeySockets/Baileys),
[Hono](https://hono.dev/) and SQLite. All state — sessions, keys, admins,
outbox jobs, settings and audit history — is in one database file; only
attachment bytes stay on disk.

> **Run one replica only.** Sessions are live in-process sockets. A second
> gateway using the same credentials will disconnect the first.

## Quick start

### Docker

```sh
docker run -d --name wa-gateway \
  --restart unless-stopped \
  -p 3005:3005 \
  -v wa-gateway-data:/data \
  ghcr.io/ridhotamma/wa-gateway:latest
```

1. Open `http://localhost:3005/console/setup` and create the first admin.
2. Copy the generated API key from **API keys**.
3. Open **Sessions**, enter a tenant slug (for example `shop`), and scan the QR
   with WhatsApp.

In production the gateway generates `WHATSAPP_API_KEY` on first boot, stores it
in `/data/bootstrap-api-key`, and reuses it across restarts. Pass
`WHATSAPP_API_KEY`, `WHATSAPP_CONSOLE_EMAIL` and `WHATSAPP_CONSOLE_PASSWORD` to
skip the setup screens.

`NODE_ENV=production` marks the console cookie `Secure`. For a remote host, use
HTTPS or an SSH tunnel (`ssh -L 3005:127.0.0.1:3005 user@host`); do not expose
plain HTTP. Images support `linux/amd64` and `linux/arm64`.

### From source

Requires Node.js 22+.

```sh
cp .env.example .env
npm install
npm run dev
```

Console: `http://localhost:3005/console` (first visit goes to `/console/setup`).
In development, API authentication is disabled when no key is configured.

### Pair a number

```sh
BASE=http://localhost:3005
KEY=<your-api-key>

# Start pairing, or return the running session.
curl -s -X POST "$BASE/sessions/shop/start" -H "x-api-key: $KEY"

# Poll until status is ready; qrDataUrl contains the QR code.
curl -s "$BASE/sessions/shop/status" -H "x-api-key: $KEY"
```

Session ids are tenant slugs: `1–64` characters of `[a-zA-Z0-9_-]`.

## API

Send JSON with an API key when one is configured:

```http
x-api-key: <key>
```

`Authorization: Bearer <key>` also works. `GET /health` is public.

| Method | Path                           | Description                              |
| ------ | ------------------------------ | ---------------------------------------- |
| GET    | `/health`                      | Liveness; inventory when authenticated   |
| POST   | `/sessions/:id/start`          | Start pairing or return the live session |
| GET    | `/sessions/:id/status`         | Status, QR data URL, outbox counters     |
| POST   | `/sessions/:id/logout`         | Unlink and delete credentials            |
| POST   | `/sessions/:id/rename`         | Rename a tenant slug (`{ "to": "new" }`) |
| GET    | `/sessions/:id/media/:mediaId` | Fetch a spooled inbound attachment       |
| POST   | `/notify/text`                 | Queue text (`202`)                       |
| POST   | `/notify/media`                | Queue media and caption (`202`)          |
| POST   | `/notify/buttons`              | Queue up to three reply buttons (`202`)  |
| POST   | `/messages/send`               | Direct text send                         |
| POST   | `/messages/send-media`         | Direct media send                        |
| POST   | `/messages/send-buttons`       | Direct reply-button send                 |

Phone numbers are digits with a country code, for example `6281234567890`. A
leading `0` is treated as Indonesian (`0812…` becomes `62812…`).

### Queue a message

Queueing is the recommended path for notifications: the call returns
immediately, and the outbox delivers when the session is ready, even if a
paired session is temporarily offline.

```sh
curl -X POST "$BASE/notify/text" \
  -H "x-api-key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "shop",
    "phone": "6281234567890",
    "kind": "order.paid",
    "text": "Payment received. Your order is being prepared.",
    "idempotencyKey": "order-1234-paid"
  }'
```

```json
{ "ok": true, "queued": true, "jobId": "…", "duplicate": false }
```

`kind` is a log label such as `order.paid`. `idempotencyKey` is unique per
session; a repeat returns `"duplicate": true`. Add `"typing": true` to text or
button requests to show “typing…” first.

**Media** (`/notify/media`) adds:

```json
"media": {
  "data": "https://cdn.example.com/invoice.pdf",
  "mimetype": "application/pdf",
  "filename": "invoice.pdf",
  "caption": "Your invoice"
}
```

`data` is a public HTTP(S) URL or base64. Queued base64 is limited to 1.5 MB;
use a URL or `/messages/send-media` for larger files.

**Buttons** (`/notify/buttons`) adds:

```json
"message": {
  "text": "Confirm your order?",
  "footer": "Reply within 24 hours",
  "buttons": [
    { "id": "confirm", "text": "Yes" },
    { "id": "cancel", "text": "No" }
  ]
}
```

Use 1–3 buttons; labels are max 20 characters. Buttons are an unofficial
WhatsApp feature, so the gateway falls back to plain text if they are rejected.

### Direct send

`POST /messages/*` sends through a ready session and is not queued or retried.
It uses `sessionId` and `to` instead of `phone`, and shares the same per-session
rate budget as the outbox.

```sh
curl -X POST "$BASE/messages/send" \
  -H "x-api-key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{ "sessionId": "shop", "to": "6281234567890", "text": "Hello." }'
```

`send-media` reuses the `media` object above; `send-buttons` reuses `message`.
On success:

```json
{ "ok": true, "result": { "id": "…", "timestamp": 1710000000 } }
```

### Errors

| Status | Meaning                                                                    |
| ------ | -------------------------------------------------------------------------- |
| `202`  | Queued in SQLite                                                           |
| `400`  | Invalid JSON, field or session id                                          |
| `401`  | Missing or invalid API key                                                 |
| `404`  | Unknown session or media id                                                |
| `409`  | Tenant not paired (`not_connected`), session not ready, or rename conflict |
| `413`  | Body too large, or queued base64 media over 1.5 MB                         |
| `422`  | Permanent failure: `not_on_whatsapp`, `invalid_recipient`, `unsafe_media`  |
| `429`  | Per-session send budget exhausted; retry later                             |
| `502`  | WhatsApp did not accept a direct send                                      |

Errors return `{ "ok": false, "error": "…" }`.

## Webhooks

Configure callbacks in **Console → Settings**, or seed them on first boot with
`WHATSAPP_INBOUND_URL` and `WHATSAPP_STATUS_URL`.

A URL may be a template containing `{sessionId}`, or a base origin. A base
origin gets `/store/{sessionId}/whatsapp` for inbound and
`/store/{sessionId}/whatsapp-status` for status appended automatically.

**Inbound message** — posted with `x-api-key`:

```json
{
  "sessionId": "shop",
  "messageId": "3EB0…",
  "from": "6281234567890",
  "body": "Is my order ready?",
  "timestamp": 1710000000,
  "hasMedia": true,
  "media": {
    "id": "a1b2…",
    "kind": "image",
    "mimetype": "image/jpeg",
    "filename": "photo.jpg",
    "sizeBytes": 182734
  }
}
```

`timestamp` is Unix seconds. Media bytes are not embedded; fetch them from
`GET /sessions/:sessionId/media/:mediaId` with the API key. The spool expires
and is size-capped (see **Settings → Media**). Only direct chats are forwarded;
groups, broadcasts, statuses and newsletters are ignored.

**Send status** — posted after each queued job settles:

```json
{ "sessionId": "shop", "idempotencyKey": "order-1234-paid", "status": "sent", "messageId": "3EB0…" }
```

A failed job sends `"status":"failed"` and a `reason` instead of `messageId`.
Webhook delivery is best-effort and never blocks the outbox.

## Console

Server-rendered at `/console`; no frontend build step.

| Page          | What it does                                                     |
| ------------- | ---------------------------------------------------------------- |
| Overview      | Sessions, queue depth, failures, active keys, media and activity |
| Sessions      | Pair, inspect QR/status, rename, log out                         |
| Notifications | Send text, buttons or media as a test                            |
| API keys      | Create named keys (shown once) and revoke them                   |
| Settings      | Pacing, typing, webhooks, media and session lifecycle            |
| Activity      | Audit history of console and message actions                     |
| Security      | Change password and revoke console sessions                      |

Console auth is email + password. Cookies are `HttpOnly`, `SameSite=Lax`,
scoped to `/console`, and `Secure` in production; cross-site form posts are
rejected. `npm run console:admin -- <email> <password>` resets a locked-out
admin.

If login says **“Cross-site request refused.”** behind a reverse proxy, set
`WHATSAPP_CONSOLE_URL` to the public origin or forward the original
`Host` / `X-Forwarded-Host` header.

## Configuration

Deployment settings come from the environment; delivery behavior is stored in
SQLite and editable from **Settings**.

| Variable                         | Default                        | Purpose                                                |
| -------------------------------- | ------------------------------ | ------------------------------------------------------ |
| `NODE_ENV`                       | `development`                  | `production` enables secure cookies and key generation |
| `HOST` / `PORT`                  | `0.0.0.0` / `3005`             | Listen address                                         |
| `WHATSAPP_LOG_LEVEL`             | `info`                         | Log level (`fatal` … `silent`)                         |
| `WHATSAPP_API_KEY`               | generated in production        | Shared API and webhook secret                          |
| `WHATSAPP_DATABASE_PATH`         | `./.whatsapp-data/gateway.db`  | SQLite file                                            |
| `WHATSAPP_MEDIA_DIR`             | `./.whatsapp-data/media`       | Attachment spool                                       |
| `WHATSAPP_CONSOLE_ENABLED`       | `true`                         | Set `false` to disable `/console`                      |
| `WHATSAPP_CONSOLE_EMAIL`         | empty                          | First admin, only when no admin exists                 |
| `WHATSAPP_CONSOLE_PASSWORD`      | empty                          | First admin password (minimum 10 characters)           |
| `WHATSAPP_CONSOLE_SESSION_HOURS` | `168`                          | Console login lifetime                                 |
| `WHATSAPP_CONSOLE_URL`           | derived from `WHATSAPP_DOMAIN` | Public origin for CSRF checks                          |
| `WHATSAPP_DOMAIN`                | empty                          | Public hostname; drives TLS and the CSRF origin        |
| `WA_GATEWAY_IMAGE`               | `…:latest`                     | Compose only: pin a published image tag                |

Runtime settings cover outbox gap/jitter/hourly cap/retries, typing, webhook
URLs and timeouts, inbound media limits/retention, pairing timeout and boot
restore. Matching environment variables seed SQLite on first boot only; after
that the console is the source of truth. See [`.env.example`](./.env.example)
for every variable and default.

Environment files load in priority order: real environment → `.env.local` →
`.env`.

## Operations

### Docker Compose with TLS

```sh
cp .env.example .env
# Set WHATSAPP_DOMAIN. Optionally seed WHATSAPP_API_KEY and the console admin.

docker compose pull gateway
docker compose up -d --no-build
docker compose logs -f gateway
```

Caddy obtains and renews TLS for `WHATSAPP_DOMAIN`; the gateway binds to
localhost only. Use `docker compose up -d --build` to build from source.

### Backups

The SQLite file is the only copy of pairings, API keys, admins and queued
messages. Losing it means every tenant must scan a new QR code and every
integration needs a new key.

```sh
scripts/backup-volumes.sh
```

It makes a WAL-safe SQLite snapshot plus media and Caddy data, with optional
off-host upload, retention and heartbeat. See the script header for options and
restore steps. Without Compose:

```sh
docker exec wa-gateway node dist/cli/backup.js /data/backups/gateway.db
docker cp wa-gateway:/data/backups/gateway.db ./gateway-backup.db
```

Archives contain live WhatsApp credentials and customer data; store them like a
password file.

### Upgrades and health

Pull the new image and recreate the container against the same `/data` volume;
migrations run at boot. Back up first.

`GET /health` is public and returns `{ status, uptime }`; add an API key for
instance id, session counts and outbox totals.

## Security notes

- Until the first admin exists, `/console/setup` can be claimed by the first
  visitor. Seed the admin in production or finish setup immediately.
- API keys and console session tokens are stored hashed; a new key is shown
  only once.
- The host stores WhatsApp credentials and customer phone numbers. Choose the
  required region and restrict access to `/data` and backups.

## Development

```sh
npm run dev         # tsx watch
npm run typecheck
npm test            # vitest
npm run build       # tsc -> dist/
npm start           # node dist/index.js
npm run backup -- /tmp/gateway-backup.db
npm run format
```

```text
src/
  http/       Hono app, REST routes, API-key auth
  console/    server-rendered admin UI and form handlers
  services/   outbox, sessions, media spool, webhooks, settings
  engine/     Baileys adapter and protocol helpers
  db/         SQLite schema, migrations, credential store
```

The console follows Shopify Polaris conventions. Icons are
[Phosphor](https://phosphoricons.com) regular paths, used under the MIT license.
