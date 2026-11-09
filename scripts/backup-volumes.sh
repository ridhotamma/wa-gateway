#!/usr/bin/env sh
# Snapshot the gateway database and media spool plus Caddy certificates.
#
# The SQLite file is the only copy of every seller's WhatsApp pairing, the API
# keys, console admins and queued notifications. Losing it means every seller
# has to scan a QR code again and every integration needs a new API key.
# A generated bootstrap API key (when WHATSAPP_API_KEY is unset) is stored in
# bootstrap-api-key beside the database and is archived too.
#
# The database copy is made with better-sqlite3's online backup API inside the
# running container (WAL-safe); media and Caddy data are tarred read-only.
#
# Run on the gateway host from cron, e.g. every 6 hours:
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

cd "$(dirname "$0")/.."

PROJECT=wa-gateway
SERVICE=gateway
BACKUP_DIR=${BACKUP_DIR:-/var/backups/wa-gateway}
BACKUP_KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
ARCHIVE="$BACKUP_DIR/wa-gateway-$STAMP.tar.gz"

umask 077
mkdir -p "$BACKUP_DIR"

# 1. A consistent SQLite snapshot inside the volume.
docker compose exec -T "$SERVICE" sh -c \
  'mkdir -p /data/backups && rm -f /data/backups/gateway.db && node dist/cli/backup.js /data/backups/gateway.db'

# 2. Archive the snapshot, media and Caddy state read-only while the daemon runs.
ARCHIVE_MEMBERS="backups/gateway.db media"
if docker compose exec -T "$SERVICE" test -f /data/bootstrap-api-key; then
  ARCHIVE_MEMBERS="$ARCHIVE_MEMBERS bootstrap-api-key"
fi
docker run --rm \
  -v "${PROJECT}_whatsapp-data:/data:ro" \
  -v "${PROJECT}_caddy-data:/caddy:ro" \
  -v "$BACKUP_DIR:/out" \
  alpine:3 \
  tar -czf "/out/wa-gateway-$STAMP.tar.gz" -C /data $ARCHIVE_MEMBERS -C /caddy .

# 3. Do not leave a second copy of the live database in the volume.
docker compose exec -T "$SERVICE" rm -f /data/backups/gateway.db

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

# Restore (gateway stopped), from the wa-gateway repo root:
#   docker compose stop gateway
#   docker run --rm -v wa-gateway_whatsapp-data:/data -v "$BACKUP_DIR:/in:ro" alpine:3 \
#     sh -c 'tar -xzf /in/wa-gateway-<STAMP>.tar.gz -C /data ./backups/gateway.db ./media \
#            && rm -f /data/gateway.db /data/gateway.db-wal /data/gateway.db-shm \
#            && mv /data/backups/gateway.db /data/gateway.db && chown -R 1000:1000 /data'
#   docker compose start gateway
#
# Add ./bootstrap-api-key to the tar member list when the archive contains it
# (the environment key was unset at backup time).
#
# The Caddy archive member is at the root of the tar (certificates and config).
