# The daemon runs on Node, not Bun: Baileys talks to WhatsApp through `ws`,
# and Bun's WebSocket replacement lacks the events Baileys listens for. The
# QR code appears under Bun but a scan never completes the link.
#
# Three stages: install, compile TypeScript, then a runtime image with only
# production dependencies and the compiled output.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3005

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Only /data is writable; the code stays root-owned.
RUN mkdir -p /data/sessions /data/outbox /data/media && chown -R node:node /data
USER node

EXPOSE 3005

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=60s \
  CMD node -e 'fetch("http://127.0.0.1:"+(process.env.PORT||"3005")+"/health").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))'

CMD ["node", "dist/index.js"]
