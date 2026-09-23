// AuthForge — zero-knowledge server schema for Cloudflare D1 (SQLite)
// The server NEVER sees plaintext secrets: only ciphertext records,
// KDF params, SHA256(auth_key), and audit metadata.
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    // SHA256(Auth Key), computed client-side and submitted at register time.
    authKeyHash: text("auth_key_hash").notNull(),
    // JSON: { algorithm: "PBKDF2-SHA256", iterations: 600000, salt: b64 }
    kdfParams: text("kdf_params").notNull(),
    // Encrypted user preferences blob (AES-GCM ciphertext JSON), nullable.
    settingsEnc: text("settings_enc"),
    // Change-password 4-step transaction lock (spec §4.5 / R8)
    syncLocked: integer("sync_locked").notNull().default(0),
    changePwToken: text("change_pw_token"),
    changePwExpires: integer("change_pw_expires"),
    // PER-USER monotonic sync sequence.
    syncVersion: integer("sync_version").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email)]
);

export const refreshTokens = sqliteTable(
  "refresh_tokens",
  {
    // SHA256(refresh_token) — raw token never stored.
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    deviceName: text("device_name"),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (t) => [
    index("idx_rt_user").on(t.userId),
    index("idx_rt_exp").on(t.expiresAt),
  ]
);

export const tokens = sqliteTable(
  "tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    // { v:1, iv(12B b64), ct(b64) } — AES-256-GCM, AAD = record id (spec §4.2)
    encryptedData: text("encrypted_data").notNull(),
    version: integer("version").notNull().default(1),
    deleted: integer("deleted").notNull().default(0), // soft-delete tombstone
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("idx_tokens_user_version").on(t.userId, t.version)]
);

export const recoveryCodes = sqliteTable(
  "recovery_codes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    tokenId: text("token_id").notNull(),
    encryptedData: text("encrypted_data").notNull(),
    version: integer("version").notNull().default(1),
    deleted: integer("deleted").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("idx_recovery_user_token").on(t.userId, t.tokenId),
    index("idx_recovery_user_ver").on(t.userId, t.version),
  ]
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    action: text("action").notNull(),
    deviceId: text("device_id"),
    ipAddress: text("ip_address"),
    details: text("details"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("idx_audit_user_time").on(t.userId, t.createdAt)]
);

export const rateLimits = sqliteTable(
  "rate_limits",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull().default(0),
    resetAt: integer("reset_at").notNull(),
    lockedUntil: integer("locked_until").notNull().default(0),
  },
  (t) => [index("idx_rl_reset").on(t.resetAt)]
);
