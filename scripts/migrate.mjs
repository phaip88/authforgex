#!/usr/bin/env node
// AuthForge — self-contained, idempotent schema bootstrap for production
// containers (no drizzle-kit needed at runtime). Statements mirror
// src/db/schema.ts; keep them in sync when the schema evolves.
//
// Safe to run on every boot: everything is IF NOT EXISTS / additive, and the
// backfill block migrates pre-1.1 databases (global `meta.server_version`)
// to the per-user sequence without data loss.
//
// Usage: DATABASE_URL=postgres://... node scripts/migrate.mjs

import pg from "pg";

const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    auth_key_hash TEXT NOT NULL,
    kdf_params TEXT NOT NULL,
    settings_enc TEXT,
    sync_locked INTEGER NOT NULL DEFAULT 0,
    change_pw_token TEXT,
    change_pw_expires BIGINT,
    sync_version BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users (email)`,
  // additive columns for databases created by an earlier version
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS change_pw_token TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS change_pw_expires BIGINT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS sync_version BIGINT NOT NULL DEFAULT 0`,

  `CREATE TABLE IF NOT EXISTS refresh_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    device_name TEXT,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    revoked_at BIGINT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rt_user ON refresh_tokens (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rt_exp ON refresh_tokens (expires_at)`,

  `CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    encrypted_data TEXT NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tokens_user_version ON tokens (user_id, version)`,

  `CREATE TABLE IF NOT EXISTS recovery_codes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    token_id TEXT NOT NULL,
    encrypted_data TEXT NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_recovery_user_token ON recovery_codes (user_id, token_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recovery_user_ver ON recovery_codes (user_id, version)`,

  `CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    action TEXT NOT NULL,
    device_id TEXT,
    ip_address TEXT,
    details TEXT,
    created_at BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_user_time ON audit_log (user_id, created_at)`,

  // Durable rate limiting / login backoff — shared by every replica.
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    reset_at BIGINT NOT NULL,
    locked_until BIGINT NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rl_reset ON rate_limits (reset_at)`,
];

// Backfill: per-user sync_version = that user's highest record version.
// Idempotent (only touches rows still at 0) and correct for both fresh and
// legacy (global-counter) databases.
const BACKFILL = `
  UPDATE users u SET sync_version = GREATEST(
    COALESCE((SELECT MAX(version) FROM tokens         WHERE user_id = u.id), 0),
    COALESCE((SELECT MAX(version) FROM recovery_codes WHERE user_id = u.id), 0)
  )
  WHERE u.sync_version = 0
`;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[migrate] DATABASE_URL is not set — skipping schema bootstrap");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  ssl: process.env.AF_DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

const maxAttempts = 10;
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  try {
    await client.connect();
    break;
  } catch (e) {
    if (attempt === maxAttempts) throw e;
    console.log(`[migrate] database not ready (attempt ${attempt}/${maxAttempts}), retrying in 2s…`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

for (const stmt of DDL) await client.query(stmt);
const res = await client.query(BACKFILL);
console.log(`[migrate] schema ready (${DDL.length} statements, ${res.rowCount ?? 0} user rows backfilled)`);
await client.end();
