# wa-gateway

[![CI](https://github.com/ridhotamma/wa-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/ridhotamma/wa-gateway/actions/workflows/ci.yml)
[![Docker](https://github.com/ridhotamma/wa-gateway/actions/workflows/docker.yml/badge.svg)](https://github.com/ridhotamma/wa-gateway/actions/workflows/docker.yml)

A standalone WhatsApp gateway: durable notifications, QR pairing, inbound
forwarding, a small REST API, and a Polaris-style admin console.

Built on **Node.js + [Hono](https://hono.dev/)**, with **SQLite** as the single
store for configuration, API keys, console accounts, the outbox, credentials
and audit history. All structured data lives in one database file; only
attachment bytes stay on disk.

> Name alternatives considered: `wa-bridge`, `sambung`, `pesanle-wa`,
> `kabel-wa`. `wa-gateway` says what it is: a transport gateway, not a chatbot.

## What it does

- **Pairing** — one Baileys session per tenant slug, QR shown in the console or
  over the API.
- **Durable outbox** — callers enqueue a message and return immediately; the
  gateway sends it when the session is ready, retries transient failures,
  deduplicates by idempotency key, and paces sends per session. Jobs are rows
  in SQLite.
- **Inbound forwarding** — customer messages and attachments are forwarded to
  a webhook (the chatbot lives there, not here).
- **Send receipts** — the final `sent` / `failed` outcome is posted back to the
  caller's status callback.
- **Direct sends** — admin test messages and seller attachments, sharing the
  same hourly send budget as the queue.
- **Media spool** — inbound attachments are written to a short-lived,
  owner-only spool; metadata is in SQLite and the webhook fetches bytes over
  the authenticated API.
- **Admin console** — dashboard, session/QR management, message tester, API key
  creation/revocation, runtime configuration, audit log, password and console
  session management.

## Requirements

- Node.js **22+** for source installs (the production image uses Node 22;
  `better-sqlite3` is a native module)
- Docker **24+** for the prebuilt image (no Node.js or build tools needed)
- A persistent volume for the SQLite database and media directory
- One replica only: sessions are in-process sockets

## Quick start

### Docker (prebuilt image)

The image is published to GitHub Container Registry and runs as the non-root
`node` user. All durable state lives in `/data`; mount a named volume there.

```sh
docker run -d --name wa-gateway \
  --restart unless-stopped \
  -p 3005:3005 \
  -v wa-gateway-data:/data \
  ghcr.io/ridhotamma/wa-gateway:latest
```

Open `http://localhost:3005/console/setup` to create the first admin. The next
screen shows the generated bootstrap API key; copy it into your integration or
create named keys later under **API keys**. No environment variables are
required: on first boot the gateway generates `WHATSAPP_API_KEY`, stores it in
`/data/bootstrap-api-key`, and keeps it across restarts.

You can still pass `WHATSAPP_API_KEY`, `WHATSAPP_CONSOLE_EMAIL` and
`WHATSAPP_CONSOLE_PASSWORD` with `-e` to skip those setup steps, which is handy
for automated deployments.

The image defaults to `NODE_ENV=production`, which marks the console cookie
`Secure`. Secure cookies work on `http://localhost`; for a remote host use the
Compose stack below with TLS (Caddy), or an SSH tunnel such as
`ssh -L 3005:127.0.0.1:3005 user@host`, rather than exposing plain HTTP.

Images are built for `linux/amd64` and `linux/arm64`. `latest` tracks `main`;
releases also publish `1`, `1.0` and `1.0.0` tags, plus `sha-<commit>`. Pin a
release tag in production:

```sh
docker pull ghcr.io/ridhotamma/wa-gateway:1.0.0
```

If the pull is denied, the GHCR package is still private: set its visibility to
public under the package settings on GitHub, or authenticate with a token that
has `read:packages`.

To upgrade, pull the new tag, stop and remove the container, then run the same
command again against the existing `wa-gateway-data` volume. Schema migrations
run automatically at boot; take a backup first.

### From source

```sh
cp .env.example .env
# optional: set WHATSAPP_API_KEY, WHATSAPP_CONSOLE_EMAIL/PASSWORD
npm install
npm run dev
```

The gateway starts on `http://localhost:3005`; the console is at
`http://localhost:3005/console`.

On first run with no admin account, the console shows `/console/setup`.
Alternatively, seed the first admin from `.env`:

```env
WHATSAPP_CONSOLE_EMAIL="admin@example.com"
WHATSAPP_CONSOLE_PASSWORD="a-long-password"
```

The env values are used only when the database has no admins. After that,
manage the account inside the console.

Pair a tenant from the console, or with the API:

```sh
curl -X POST http://localhost:3005/sessions/shop/start \
  -H "x-api-key: $WHATSAPP_API_KEY"
```

## Console

The console is server-rendered with the same Polaris-inspired styling as the
Bunwrite console: light canvas, one sidebar, white cards, tone badges and a
single primary action per page. It has no frontend build step.

| Page          | What it does                                                        |
| ------------- | ------------------------------------------------------------------- |
| Overview      | Sessions, queue depth, failures, active keys, media spool, activity |
| Sessions      | Pair, inspect QR/status, rename, log out                            |
| Notifications | Send text, text + buttons, or media; direct or queued               |
| API keys      | Create named keys (shown once), revoke them                         |
| Settings      | Outbox pacing, typing, webhooks, media and session lifecycle        |
| Activity      | Audit history of console and message actions                        |
| Security      | Change password, list/revoke console sessions                       |

Console authentication is email + password. Admins and sessions are rows in
SQLite; session cookies contain a random bearer token and the database stores
only its SHA-256 hash. Cookies are `HttpOnly`, `SameSite=Lax`, scoped to
`/console`, and `Secure` in production. Cross-site form posts are refused.

Until the first admin exists, `/console/setup` is claimable by whoever reaches
it first. On production, seed the admin from `WHATSAPP_CONSOLE_EMAIL` and
`WHATSAPP_CONSOLE_PASSWORD`, or finish setup immediately after deployment.
After setup, the API keys page shows the generated bootstrap key when the
environment key was not supplied. The `console:admin` CLI can reset a password
if the account is locked out.

If login says **"Cross-site request refused."** behind a reverse proxy, set
`WHATSAPP_CONSOLE_URL` to the public origin (for example
`https://whatsapp.example.com`), or make the proxy forward the original
`Host` / `X-Forwarded-Host`. The bundled Compose setup derives this from
`WHATSAPP_DOMAIN` automatically.

## API

All routes except public liveness require an API key, as
`x-api-key: <key>` or `Authorization: Bearer <key>`. The environment key
(`WHATSAPP_API_KEY`) is permanent; keys created in the console can be revoked.
When the environment key is missing, production generates one on first boot and
shows it in the console after setup.

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

- `202` — queued in SQLite
- `409 not_connected` — tenant has not linked WhatsApp
- `413` — queued media over 1.5 MB must be a URL
- `422` — permanent send failure (`not_on_whatsapp`, `invalid_recipient`,
  `unsafe_media`)
- `429` — the session's send budget is exhausted; retry later

## Architecture

```
src/
  index.ts                     bootstrap: env → SQLite → services → HTTP
  config.ts                    typed environment (deployment-level)
  server.ts                    Node HTTP server + graceful stop
  db/
    schema.ts                  SQLite schema (versioned migrations)
    database.ts                open, WAL, foreign keys, transaction helper
    whatsapp-auth-store.ts     Baileys credentials + signal keys in SQLite
  http/
    app.ts                     Hono app, middleware, error mapping
    routes/                    health, sessions, notify, messages
    middleware/                API-key auth, request id + structured logging
  console/
    router.ts                  server-rendered pages and form handlers
    auth.ts                    cookie sessions, CSRF, login rate limit
    layout.ts, styles.ts, ui.ts  Polaris-style chrome and components
    pages/                     overview, sessions, notifications, keys, settings…
  services/
    settings-store.ts          one runtime settings row in SQLite, live updates
    api-key-store.ts           named hashed keys + last-used tracking
    console-auth.ts            admins, scrypt hashes, console sessions
    audit-log.ts               console and message audit trail
    session-manager.ts         lifecycle, restore, typing, session registry
    outbox.ts                  SQLite queue, pacing, retries, idempotency
    media-store.ts             attachment files + SQLite metadata
    inbound-forwarder.ts       customer message → webhook
    status-reporter.ts         sent / failed → webhook
    direct-send.ts             non-queued sends
    typing.ts                  human-looking "typing…"
  engine/
    types.ts, errors.ts        engine contracts
    identity/wa-id.ts          phone / JID normalization
    baileys/                   socket adapter, auth state, media, buttons
  lib/
    callbacks.ts, logger.ts, phone.ts
```

### SQLite tables

| Table                | Contains                                                    |
| -------------------- | ----------------------------------------------------------- |
| `settings`           | Runtime configuration (one validated JSON row)              |
| `api_keys`           | Named key hashes, prefix, last used, revoked time           |
| `console_admins`     | Email and scrypt password hash                              |
| `console_sessions`   | Hashed console session tokens and expiry                    |
| `outbox_jobs`        | Pending/done/failed messages, retry state, idempotency keys |
| `whatsapp_sessions`  | Credentials JSON plus last status per tenant                |
| `whatsapp_auth_keys` | Baileys signal keys per session                             |
| `media_spool`        | Attachment metadata and relative file paths                 |
| `audit_log`          | Console actions and message tests                           |

Database defaults to `./.whatsapp-data/gateway.db`. Attachment bytes default
to `./.whatsapp-data/media`.

### Outbound flow

1. A caller posts to `/notify/*` (or uses the console tester).
2. The job is inserted into `outbox_jobs` and the API answers `202` with
   `{ jobId, duplicate }`.
3. The outbox worker sends when the session is `ready`, respecting the
   per-session gap, jitter and hourly cap.
4. Success scrubs the row's recipient and body but keeps an idempotency marker;
   permanent failure keeps only a masked recipient and reason.
5. `onSettled` posts the outcome to the status callback.

### Inbound flow

1. Baileys receives a direct customer message.
2. Media bytes are downloaded (up to the configured limit), written to the
   media directory, and described in `media_spool`.
3. The forwarder posts `{ sessionId, messageId, from, body, timestamp,
hasMedia, media? }` to the inbound webhook; the webhook fetches bytes from
   `/sessions/:sessionId/media/:mediaId`.

## Configuration

Deployment values live in the environment; operator-tunable settings are in
SQLite and editable from the console. The outbox/typing/webhook/media/session
variables in `.env` seed SQLite on first boot only; after that, the console is
the source of truth. See [`.env.example`](./.env.example).

| Variable                         | Default                        | Notes                                                                        |
| -------------------------------- | ------------------------------ | ---------------------------------------------------------------------------- |
| `NODE_ENV`                       | `development`                  | `production` enables secure cookies and key generation                       |
| `HOST` / `PORT`                  | `0.0.0.0` / `3005`             |                                                                              |
| `WHATSAPP_LOG_LEVEL`             | `info`                         | pino level                                                                   |
| `WHATSAPP_API_KEY`               | empty                          | Optional; production generates one on first boot and shows it in the console |
| `WHATSAPP_DATABASE_PATH`         | `./.whatsapp-data/gateway.db`  | SQLite file                                                                  |
| `WHATSAPP_MEDIA_DIR`             | `./.whatsapp-data/media`       | Attachment bytes                                                             |
| `WHATSAPP_CONSOLE_ENABLED`       | `true`                         | Set `false` to hide `/console`                                               |
| `WHATSAPP_CONSOLE_EMAIL`         | empty                          | Bootstrap admin only; otherwise use `/console/setup`                         |
| `WHATSAPP_CONSOLE_PASSWORD`      | empty                          | Bootstrap admin only (min 10 characters)                                     |
| `WHATSAPP_CONSOLE_SESSION_HOURS` | `168`                          | Console session lifetime                                                     |
| `WHATSAPP_CONSOLE_URL`           | derived from `WHATSAPP_DOMAIN` | Public console origin for CSRF checks                                        |

The Settings page controls outbox gap/jitter/cap/retries, typing simulation,
inbound/status webhook URLs and timeouts, media limits and retention, pairing
timeout and boot restore. Changes apply immediately; boot-restore values take
effect on the next start.

Env loading order: real environment → `.env.local` → `.env`. Real variables
always win; `.env.local` wins over `.env`.

## Operations

### Docker Compose

The Compose stack runs the gateway behind Caddy (automatic TLS). It can pull
the published image or build from source:

```sh
cp .env.example .env
# optionally fill WHATSAPP_API_KEY, WHATSAPP_CONSOLE_EMAIL/PASSWORD, WHATSAPP_DOMAIN
# (leave the key and admin empty to finish setup in /console/setup)

# Prebuilt image:
docker compose pull gateway
docker compose up -d --no-build

# Or build from this checkout:
docker compose up -d --build

docker compose logs -f gateway
```

Caddy obtains and renews TLS for `WHATSAPP_DOMAIN` automatically. The gateway
port is bound to localhost only. Set `WA_GATEWAY_IMAGE` in `.env` to pin a
release instead of `ghcr.io/ridhotamma/wa-gateway:latest`.

### Backups

`scripts/backup-volumes.sh` makes a WAL-safe copy of SQLite with
better-sqlite3's online backup API, plus the media spool and Caddy data, then
supports off-host upload and a heartbeat. Losing the database means every
seller must scan a new QR code and every integration needs a new API key. Run
it from cron, e.g. every 6 hours:

```cron
0 */6 * * * /opt/wa-gateway/scripts/backup-volumes.sh >> /var/log/wa-gateway-backup.log 2>&1
```

The archive contains live credentials and customer phone numbers; store it
like a password file.

Inside a container, the same backup runs with the bundled CLI:

```sh
docker exec wa-gateway node dist/cli/backup.js /data/backups/gateway.db
docker cp wa-gateway:/data/backups/gateway.db ./gateway-backup.db
```

### Data residency

The host stores live WhatsApp credentials and queued customer phone numbers
and order details. Keep it in the region your privacy policy commits to
(ap-southeast-1 for Pesanle).

### Health

`GET /health` is public and returns only `{ status, uptime }`. Send an API key
to get the instance id, session counts and outbox totals.

## Development

```sh
npm run dev         # tsx watch
npm run typecheck
npm test            # vitest
npm run build       # tsc -> dist/
npm start           # node dist/index.js
npm run backup -- /tmp/gateway-backup.db
npm run console:admin -- admin@example.com new-long-password
npm run format
```

Tests cover the outbox timing/idempotency, SQLite stores, media spool, callback
URLs, typing, Baileys protocol helpers, console auth/CSRF, API auth and all
HTTP routes.

## Migrating from the original monorepo daemon

- The app moved out of `apps/whatsapp`; the engine moved out of
  `packages/whatsapp`.
- Sessions, the outbox and settings are now in **SQLite**, not JSON files and
  credential directories. Existing file-based data is not imported; re-pair
  sessions once and create API keys in the console.
- `@repo/env` was replaced by Node's `process.loadEnvFile`.
- `@repo/observability` was replaced by structured pino logs on stdout.
  Collect them with your container log pipeline.
- API route shapes and status codes are unchanged. Clients still need only
  `WHATSAPP_SERVICE_URL` and `WHATSAPP_API_KEY`.

## Credits

The console follows Shopify Polaris conventions, adapted from the Bunwrite
console. Its icons are [Phosphor](https://phosphoricons.com) regular
(outlined) paths, inlined under the MIT license; the WhatsApp mark lives in
`src/console/ui.ts` as `whatsapp-logo`.
