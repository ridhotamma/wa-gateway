/**
 * SQLite schema, version 1.
 *
 * Everything structured lives here: runtime settings, API keys, console
 * admins and sessions, durable outbox jobs, WhatsApp credentials and auth
 * keys, inbound media metadata and the console audit log. Only attachment
 * bytes live on disk, because a 16 MB blob belongs in object storage, not in
 * the database file that is backed up every few hours.
 */
export const SCHEMA_VERSION = 1

export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  hash         TEXT NOT NULL UNIQUE,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS api_keys_revoked_at ON api_keys (revoked_at);

CREATE TABLE IF NOT EXISTS console_admins (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS console_sessions (
  id           TEXT PRIMARY KEY,
  admin_id     TEXT NOT NULL REFERENCES console_admins (id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);
CREATE INDEX IF NOT EXISTS console_sessions_admin ON console_sessions (admin_id);
CREATE INDEX IF NOT EXISTS console_sessions_expiry ON console_sessions (expires_at);

CREATE TABLE IF NOT EXISTS outbox_jobs (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  idempotency_key TEXT,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
  to_phone        TEXT NOT NULL,
  text            TEXT NOT NULL,
  media_json      TEXT,
  buttons_json    TEXT,
  footer          TEXT,
  typing          INTEGER NOT NULL DEFAULT 0,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error      TEXT,
  message_id      TEXT,
  fail_reason     TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  failed_at       INTEGER
);
CREATE INDEX IF NOT EXISTS outbox_jobs_due ON outbox_jobs (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS outbox_jobs_session ON outbox_jobs (session_id, status);
CREATE INDEX IF NOT EXISTS outbox_jobs_created ON outbox_jobs (created_at);
CREATE UNIQUE INDEX IF NOT EXISTS outbox_jobs_idempotency
  ON outbox_jobs (session_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS whatsapp_sessions (
  session_id          TEXT PRIMARY KEY,
  creds_json          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  last_status         TEXT,
  last_status_reason  TEXT,
  last_connected_at   TEXT
);

CREATE TABLE IF NOT EXISTS whatsapp_auth_keys (
  session_id TEXT NOT NULL
    REFERENCES whatsapp_sessions (session_id) ON DELETE CASCADE ON UPDATE CASCADE,
  category   TEXT NOT NULL,
  key_id     TEXT NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY (session_id, category, key_id)
);

CREATE TABLE IF NOT EXISTS media_spool (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  mimetype      TEXT NOT NULL,
  filename      TEXT,
  size_bytes    INTEGER NOT NULL,
  relative_path TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS media_spool_session ON media_spool (session_id);
CREATE INDEX IF NOT EXISTS media_spool_expiry ON media_spool (expires_at);
CREATE INDEX IF NOT EXISTS media_spool_created ON media_spool (created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at);
`
