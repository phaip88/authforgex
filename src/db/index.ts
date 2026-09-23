import * as schema from "./schema";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

export type Db = DrizzleD1Database<typeof schema>;

// Interface matching Cloudflare D1 database API
interface D1DatabaseBinding {
  prepare: (query: string) => any;
  dump: () => Promise<ArrayBuffer>;
  batch: (statements: unknown[]) => Promise<unknown[]>;
  exec: (query: string) => Promise<unknown>;
}

const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    auth_key_hash TEXT NOT NULL,
    kdf_params TEXT NOT NULL,
    settings_enc TEXT,
    sync_locked INTEGER NOT NULL DEFAULT 0,
    change_pw_token TEXT,
    change_pw_expires INTEGER,
    sync_version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users (email)`,
  `CREATE TABLE IF NOT EXISTS refresh_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    device_name TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rt_user ON refresh_tokens (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_rt_exp ON refresh_tokens (expires_at)`,
  `CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    encrypted_data TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tokens_user_version ON tokens (user_id, version)`,
  `CREATE TABLE IF NOT EXISTS recovery_codes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    token_id TEXT NOT NULL,
    encrypted_data TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_recovery_user_token ON recovery_codes (user_id, token_id)`,
  `CREATE INDEX IF NOT EXISTS idx_recovery_user_ver ON recovery_codes (user_id, version)`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    action TEXT NOT NULL,
    device_id TEXT,
    ip_address TEXT,
    details TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_user_time ON audit_log (user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    reset_at INTEGER NOT NULL,
    locked_until INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rl_reset ON rate_limits (reset_at)`,
];

let schemaEnsured: Promise<void> | null = null;
export async function ensureD1Schema(rawD1: D1DatabaseBinding): Promise<void> {
  if (schemaEnsured) return schemaEnsured;
  schemaEnsured = (async () => {
    try {
      const stmts = DDL_STATEMENTS.map((sql) => rawD1.prepare(sql));
      await rawD1.batch(stmts);
    } catch (err) {
      console.error("[authforge] Auto-DDL batch error:", err);
      schemaEnsured = null;
      throw err;
    }
  })();
  return schemaEnsured;
}

function wrapD1(rawD1: D1DatabaseBinding): D1DatabaseBinding {
  return {
    prepare(query: string) {
      const stmt = rawD1.prepare(query) as any;
      return new Proxy(stmt, {
        get(target, prop, receiver) {
          const orig = Reflect.get(target, prop, receiver);
          if (typeof orig === "function" && ["all", "run", "first", "raw", "values"].includes(String(prop))) {
            return async function (...args: any[]) {
              await ensureD1Schema(rawD1);
              return orig.apply(target, args);
            };
          }
          if (typeof orig === "function" && prop === "bind") {
            return function (...bindArgs: any[]) {
              const boundStmt = orig.apply(target, bindArgs);
              return new Proxy(boundStmt, {
                get(bTarget, bProp, bReceiver) {
                  const bOrig = Reflect.get(bTarget, bProp, bReceiver);
                  if (typeof bOrig === "function" && ["all", "run", "first", "raw", "values"].includes(String(bProp))) {
                    return async function (...args: any[]) {
                      await ensureD1Schema(rawD1);
                      return bOrig.apply(bTarget, args);
                    };
                  }
                  return typeof bOrig === "function" ? bOrig.bind(bTarget) : bOrig;
                },
              });
            };
          }
          return typeof orig === "function" ? orig.bind(target) : orig;
        },
      });
    },
    async batch(statements: unknown[]) {
      await ensureD1Schema(rawD1);
      return rawD1.batch(statements);
    },
    async exec(query: string) {
      return rawD1.exec(query);
    },
    dump: rawD1.dump ? rawD1.dump.bind(rawD1) : async () => new ArrayBuffer(0),
  };
}

function getD1Binding(): D1DatabaseBinding | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getCloudflareContext } = require("@opennextjs/cloudflare");
    const ctx = getCloudflareContext();
    if (ctx?.env?.DB) {
      return ctx.env.DB as D1DatabaseBinding;
    }
  } catch {
    // Non-Cloudflare or build-time context
  }
  return null;
}

export function getDb(): Db {
  const rawD1 = getD1Binding();
  if (rawD1) {
    const d1 = wrapD1(rawD1);
    const instance = drizzle(d1, { schema });
    // Cloudflare D1 does not support interactive BEGIN/COMMIT statements.
    // Wrap transaction() to execute callback directly on the D1 client.
    (instance as any).transaction = async (cb: (tx: any) => Promise<any>) => {
      return cb(instance);
    };
    return instance;
  }

  // Graceful proxy for build-time evaluation
  return new Proxy({} as Db, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      return () => {
        throw new Error(
          "[authforge] Cloudflare D1 binding 'DB' is not available. Please verify 'd1_databases' configuration in wrangler.jsonc."
        );
      };
    },
  });
}

export const db: Db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    const instance = getDb();
    const value = Reflect.get(instance, prop, receiver);
    if (typeof value === "function") {
      return value.bind(instance);
    }
    return value;
  },
});
