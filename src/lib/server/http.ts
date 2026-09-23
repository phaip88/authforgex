import { timingSafeEqual, createHmac } from "node:crypto";
import { db } from "@/db";
import { auditLog, users } from "@/db/schema";
import { verifyAccessToken } from "./jwt";
import { eq, sql } from "drizzle-orm";

// ---------- RFC 7807 problem+json (spec §9 / R21) ----------
export function problem(
  status: number,
  code: string,
  title: string,
  detail?: string,
  headers?: Record<string, string>
) {
  return Response.json(
    {
      type: `https://authforge.dev/problems/${code}`,
      title,
      status,
      detail,
      code,
    },
    { status, headers: { "content-type": "application/problem+json", ...headers } }
  );
}

// ---------- Auth guard ----------
export async function requireAuth(req: Request): Promise<string | null> {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) return null;
  const v = await verifyAccessToken(m[1]);
  return v?.sub ?? null;
}

export const unauthorized = () =>
  problem(401, "unauthorized", "Authentication required");

// =====================================================================
// Rate limiting & login backoff (spec §9)
//
// Backed by Postgres, NOT process memory: a Map only works for exactly one
// long-lived instance. With two replicas (or any serverless/edge runtime) each
// node keeps its own counters, so an attacker gets N× the allowance and every
// deploy wipes the ban list. The single-statement upsert below is atomic, so
// concurrent requests cannot both "win" a slot.
//
// A tiny in-process cache short-circuits obvious over-limit cases to avoid a
// round trip per request, and the whole thing degrades to memory-only if the
// database is unreachable (availability > perfect accounting for a 2FA vault).
// No module-scope timers are used, so the module is safe to import in
// request-scoped runtimes (Workers, Lambda) where background timers are killed.
// =====================================================================

interface MemBucket {
  count: number;
  resetAt: number;
}
const mem = new Map<string, MemBucket>();
const MEM_MAX = 5_000;

/** Opportunistic sweep — replaces setInterval, which edge runtimes forbid. */
function sweepMemory(now: number): void {
  if (mem.size < MEM_MAX) return;
  for (const [k, b] of mem) if (b.resetAt <= now) mem.delete(k);
  if (mem.size >= MEM_MAX) mem.clear(); // hard cap: never grow unbounded
}

function memHit(key: string, limit: number, windowMs: number, now: number): { ok: boolean; retryAfterS: number } {
  sweepMemory(now);
  let b = mem.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    mem.set(key, b);
  }
  b.count += 1;
  return b.count > limit
    ? { ok: false, retryAfterS: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) }
    : { ok: true, retryAfterS: 0 };
}

/**
 * Consume one token from a fixed window. Atomic across instances.
 * Returns `{ ok:false, retryAfterS }` when the caller is over the limit.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowMs = 60_000
): Promise<{ ok: boolean; retryAfterS: number }> {
  const now = Date.now();
  const resetAt = now + windowMs;
  try {
    const res = await db.all<{ count: number; reset_at: string | number }>(sql`
      INSERT INTO rate_limits (key, count, reset_at, locked_until)
      VALUES (${key}, 1, ${resetAt}, 0)
      ON CONFLICT (key) DO UPDATE SET
        count    = CASE WHEN rate_limits.reset_at <= ${now} THEN 1 ELSE rate_limits.count + 1 END,
        reset_at = CASE WHEN rate_limits.reset_at <= ${now} THEN ${resetAt} ELSE rate_limits.reset_at END
      RETURNING count, reset_at
    `);
    const row = res[0];
    if (!row) return { ok: true, retryAfterS: 0 };
    const count = Number(row.count);
    const reset = Number(row.reset_at);
    // Opportunistic GC (~0.5% of calls) instead of a background timer.
    if (Math.random() < 0.005) {
      void db
        .run(sql`DELETE FROM rate_limits WHERE reset_at < ${now - 3_600_000} AND locked_until < ${now}`)
        .catch(() => undefined);
    }
    return count > limit
      ? { ok: false, retryAfterS: Math.max(1, Math.ceil((reset - now) / 1000)) }
      : { ok: true, retryAfterS: 0 };
  } catch {
    return memHit(key, limit, windowMs, now); // DB down → best-effort local limit
  }
}

export function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "local"
  );
}

// ---------- Login failure backoff (spec §4.4) ----------
// 5 failures → lock 60 s, doubling per additional failure, capped at 15 min.
const LOCK_BASE_MS = 60_000;
const LOCK_CAP_MS = 15 * 60_000;
const FAIL_WINDOW_MS = 60 * 60_000;
const memLock = new Map<string, number>();

const lockKey = (email: string) => `lf:${email.toLowerCase()}`;

/** Seconds remaining on an active lock, or 0. */
export async function checkLoginBackoff(email: string): Promise<number> {
  const now = Date.now();
  try {
    const res = await db.all<{ locked_until: string | number }>(
      sql`SELECT locked_until FROM rate_limits WHERE key = ${lockKey(email)}`
    );
    const row = res[0];
    const until = Number(row?.locked_until ?? 0);
    return until > now ? Math.ceil((until - now) / 1000) : 0;
  } catch {
    const until = memLock.get(lockKey(email)) ?? 0;
    return until > now ? Math.ceil((until - now) / 1000) : 0;
  }
}

export async function recordLoginFailure(email: string): Promise<void> {
  const now = Date.now();
  const key = lockKey(email);
  try {
    const res = await db.all<{ count: number }>(sql`
      INSERT INTO rate_limits (key, count, reset_at, locked_until)
      VALUES (${key}, 1, ${now + FAIL_WINDOW_MS}, 0)
      ON CONFLICT (key) DO UPDATE SET
        count    = CASE WHEN rate_limits.reset_at <= ${now} THEN 1 ELSE rate_limits.count + 1 END,
        reset_at = ${now + FAIL_WINDOW_MS}
      RETURNING count
    `);
    const row = res[0];
    const count = Number(row?.count ?? 1);
    if (count >= 5) {
      const backoff = Math.min(LOCK_BASE_MS * 2 ** (count - 5), LOCK_CAP_MS);
      await db.run(sql`UPDATE rate_limits SET locked_until = ${now + backoff} WHERE key = ${key}`);
    }
  } catch {
    const b = memHit(key, Number.MAX_SAFE_INTEGER, FAIL_WINDOW_MS, now);
    void b;
    const count = mem.get(key)?.count ?? 1;
    if (count >= 5) memLock.set(key, now + Math.min(LOCK_BASE_MS * 2 ** (count - 5), LOCK_CAP_MS));
  }
}

export async function resetLoginFailures(email: string): Promise<void> {
  const key = lockKey(email);
  mem.delete(key);
  memLock.delete(key);
  try {
    await db.run(sql`DELETE FROM rate_limits WHERE key = ${key}`);
  } catch {
    /* memory copy already cleared */
  }
}

// ---------- Timing-safe comparison of hex digests ----------
export function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

// Deterministic fake KDF params for unknown emails (anti-enumeration,
// spec §4.4: prelogin must not reveal account existence).
export function fakeKdfParams(email: string): string {
  const pepper =
    process.env.AF_JWT_SECRET ||
    "authforge-dev-secret-change-me-0123456789abcdef";
  const salt = createHmac("sha256", pepper).update(`prelogin:${email.toLowerCase()}`).digest();
  return JSON.stringify({
    algorithm: "PBKDF2-SHA256",
    iterations: 600000,
    salt: salt.toString("base64"),
  });
}

// ---------- Audit (spec §12.6) ----------
export async function audit(
  userId: string,
  action: string,
  req?: Request,
  details?: Record<string, unknown>
) {
  try {
    await db.insert(auditLog).values({
      userId,
      action,
      ipAddress: req ? clientIp(req) : null,
      details: details ? JSON.stringify(details) : null,
      createdAt: Date.now(),
    });
  } catch {
    // audit must never break the request path
  }
}

export async function getUserByEmail(email: string) {
  const rows = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  return rows[0] ?? null;
}

/** Shared helper so every route emits an identical 429. */
export function tooMany(retryAfterS: number) {
  return problem(429, "rate_limited", "Too many requests", undefined, {
    "retry-after": String(Math.max(1, retryAfterS)),
  });
}
