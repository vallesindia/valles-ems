// Postgres access (node-postgres). Works with Cloud SQL via the Cloud Run unix socket.
//
// Connection settings (any one style):
//   DATABASE_URL                         full URL (local dev / docker)
//   DB_HOST + DB_USER + DB_NAME + DB_PASSWORD
//        DB_HOST can be a unix socket dir, e.g. /cloudsql/PROJECT:REGION:INSTANCE
// Passwords are passed as an object field, so no URL-encoding problems with special characters.

import pg from 'pg';

const { Pool } = pg;

export function makePool() {
  if (process.env.DATABASE_URL) {
    return new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  }
  return new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
    max: 5,
  });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_state (
  id            TEXT PRIMARY KEY,
  data          JSONB       NOT NULL,
  content_hash  TEXT        NOT NULL,
  record_count  INTEGER     NOT NULL DEFAULT 0,
  version       INTEGER     NOT NULL DEFAULT 1,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    TEXT
);

CREATE TABLE IF NOT EXISTS state_history (
  id            BIGSERIAL PRIMARY KEY,
  saved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  saved_by      TEXT,
  record_count  INTEGER NOT NULL DEFAULT 0,
  data          JSONB   NOT NULL
);
CREATE INDEX IF NOT EXISTS state_history_saved_at_idx ON state_history (saved_at DESC);

CREATE TABLE IF NOT EXISTS backups (
  id          TEXT PRIMARY KEY,
  name        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  TEXT,
  size_bytes  INTEGER     NOT NULL DEFAULT 0,
  data        JSONB       NOT NULL
);
CREATE INDEX IF NOT EXISTS backups_created_at_idx ON backups (created_at DESC);
`;

export async function initSchema(pool, attempts = 5) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query(SCHEMA);
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[db] schema init attempt ${i}/${attempts} failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw lastErr;
}
