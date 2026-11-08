#!/usr/bin/env sh
# Snapshot the WhatsApp daemon's volumes (paired sessions, queued outbox,
# Caddy certs). The sessions volume is the only copy of every seller's
# pairing: lose it and every seller has to re-scan a QR code.
#
# Run on the WhatsApp host from cron, e.g. every 6 hours:
#   0 */6 * * * /opt/wa-gateway/scripts/backup-volumes.sh >> /var/log/wa-gateway-backup.log 2>&1
#
# Environment:
#   BACKUP_DIR        where archives go (default /var/backups/wa-gateway)
#   BACKUP_KEEP_DAYS  retention in days (default 14)
#   BACKUP_UPLOAD_CMD optional command run with the archive path as $1, to
#                     copy it off-host. Cloudflare R2 example, with
#                     AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY from an R2 API
#                     token in the environment:
#                       aws s3 cp "$1" "s3://<bucket>/whatsapp/" \
#                         --endpoint-url "https://<account>.r2.cloudflarestorage.com" \
#                         --region auto
#                     The bucket MUST be in the APAC location hint: archives
#                     hold seller credentials and customer phone numbers.
#   BACKUP_REQUIRE_OFFHOST  1 makes a missing/failing BACKUP_UPLOAD_CMD fatal.
#   BACKUP_HEARTBEAT_URL       pinged once after every successful run; any
#                     dead-man's-switch that records a hit works. Unset
#                     disables the ping.
#   BACKUP_HEARTBEAT_FAIL_URL  pinged instead when the run fails; optional.
#
# Archives contain live WhatsApp credentials — they are written 0600 and
# should be treated like a password file.
set -eu

HEARTBEAT_URL=${BACKUP_HEARTBEAT_URL:-}
HEARTBEAT_FAIL_URL=${BACKUP_HEARTBEAT_FAIL_URL:-}
REQUIRE_OFFHOST=${BACKUP_REQUIRE_OFFHOST:-0}

ping_url() {
  url=$1
  [ -n "$url" ] || return 0
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -m 10 "$url" >/dev/null 2>&1 && return 0
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 10 -O /dev/null "$url" && return 0
  fi
  echo "[backup] warn: could not ping $url" >&2
  return 1
}

heartbeat_exit() {
  status=$?
  trap - EXIT
  if [ "$status" -eq 0 ]; then
    ping_url "$HEARTBEAT_URL" || true
  else
    echo "[backup] FATAL: backup failed (exit $status)" >&2
    ping_url "$HEARTBEAT_FAIL_URL" || true
  fi
  exit "$status"
}
trap heartbeat_exit EXIT

PROJECT=wa-gateway
BACKUP_DIR=${BACKUP_DIR:-/var/backups/wa-gateway}
BACKUP_KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVE="$BACKUP_DIR/wa-gateway-$STAMP.tar.gz"

umask 077
mkdir -p "$BACKUP_DIR"

# Read-only mounts: the daemon keeps running. Baileys writes creds with
# whole-file writes, so a snapshot is consistent per file.
docker run --rm \
  -v "${PROJECT}_whatsapp-sessions:/backup/sessions:ro" \
  -v "${PROJECT}_whatsapp-outbox:/backup/outbox:ro" \
  -v "${PROJECT}_caddy-data:/backup/caddy-data:ro" \
  -v "$BACKUP_DIR:/out" \
  alpine:3 \
  tar -czf "/out/wa-gateway-$STAMP.tar.gz" -C /backup .

chmod 600 "$ARCHIVE"
echo "[backup] wrote $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

if [ -n "${BACKUP_UPLOAD_CMD:-}" ]; then
  sh -c "$BACKUP_UPLOAD_CMD" upload "$ARCHIVE"
  echo "[backup] uploaded $ARCHIVE"
elif [ "$REQUIRE_OFFHOST" = "1" ]; then
  echo "[backup] FATAL: BACKUP_REQUIRE_OFFHOST=1 but BACKUP_UPLOAD_CMD is unset." >&2
  exit 1
fi

find "$BACKUP_DIR" -name 'wa-gateway-*.tar.gz' -mtime +"$BACKUP_KEEP_DAYS" -delete

# Restore (daemon stopped), from the wa-gateway repo root:
#   docker compose stop gateway
#   docker run --rm -v wa-gateway_whatsapp-sessions:/r/sessions \
#     -v wa-gateway_whatsapp-outbox:/r/outbox -v "$BACKUP_DIR:/in:ro" alpine:3 \
#     sh -c 'tar -xzf /in/wa-gateway-<STAMP>.tar.gz -C /r ./sessions ./outbox && chown -R 1000:1000 /r'
#   docker compose start gateway
