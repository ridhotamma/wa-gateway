# The daemon runs on Node, not Bun: Baileys talks to WhatsApp through `ws`,
# and Bun's WebSocket replacement lacks the events Baileys listens for. The
# QR code appears under Bun but a scan never completes the link.
#
# better-sqlite3 is a native module. It usually downloads a prebuilt binary;
# the build tools below are the fallback when a platform has none.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Production node_modules are built on the same base image as the runtime, so
# the native SQLite binary matches the libc and Node ABI exactly.
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3005 \
    WHATSAPP_DATABASE_PATH=/data/gateway.db \
    WHATSAPP_MEDIA_DIR=/data/media

COPY package.json package-lock.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public

# Only /data is writable: SQLite (settings, keys, outbox, credentials, audit)
# and the transient media spool. The code stays root-owned.
RUN mkdir -p /data/media /data/backups && chown -R node:node /data && chmod 700 /data
USER node

EXPOSE 3005

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=60s \
  CMD node -e 'fetch("http://127.0.0.1:"+(process.env.PORT||"3005")+"/health").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))'

CMD ["node", "dist/index.js"]
