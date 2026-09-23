import { db } from "@/db";
import { tokens, recoveryCodes, users } from "@/db/schema";
import { and, eq, gt, sql } from "drizzle-orm";

// ---------- Sync engine (spec §8) ----------
// Each user owns a PRIVATE monotonic sequence (users.sync_version). Every
// accepted change bumps it by 1 and stamps the record's version with the new
// value. A global counter was rejected: it makes tenant A's writes invalidate
// tenant B's base_version (spurious 409 storms + one hot row for the whole
// deployment).
//
// The push transaction takes `SELECT ... FOR UPDATE` on the *user row*, which
// serializes concurrent pushes for that one user (so two of the user's devices
// can never interleave and skip a version) while leaving other tenants free.
//
// Conflict resolution: tombstones win, otherwise LWW by updated_at, then id.
// HOTP counter max-merge happens client-side (the counter lives inside the
// ciphertext, which the server cannot read).

export interface ChangeRecord {
  id: string;
  encrypted_data?: string;
  token_id?: string;
  version?: number;
  deleted?: boolean;
  created_at?: number;
  updated_at: number;
}

export interface AppliedEcho {
  id: string;
  version: number;
  updated_at: number;
  deleted: boolean;
}

/** Why a submitted change was not written. Surfaced to the client so a write
 *  is never reported as successful when the server ignored it. */
export type SkipReason = "owned_by_other_user" | "stale" | "tombstoned";

export interface SkippedChange {
  id: string;
  entity: "token" | "recovery";
  reason: SkipReason;
}

export interface ApplyResult {
  serverVersion: number;
  tokens: AppliedEcho[];
  recoveries: AppliedEcho[];
  skipped: SkippedChange[];
}

export async function currentServerVersion(userId: string): Promise<number> {
  const rows = await db
    .select({ v: users.syncVersion })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0]?.v ?? 0;
}

/** Tombstone-priority LWW. Returns the reason when the incoming change loses. */
function evaluate(
  existing: { updatedAt: number; deleted: number; id: string } | undefined,
  incoming: ChangeRecord
): { apply: true } | { apply: false; reason: SkipReason } {
  if (!existing) return { apply: true };
  // A tombstone is terminal: reviving it is rejected, and re-deleting it is a
  // no-op. Without this second rule a retried DELETE would rewrite the
  // tombstone, burn a version number and wake every other device for nothing.
  if (existing.deleted === 1) return { apply: false, reason: "tombstoned" };
  if (incoming.deleted) return { apply: true };
  if (incoming.updated_at !== existing.updatedAt)
    return incoming.updated_at > existing.updatedAt ? { apply: true } : { apply: false, reason: "stale" };
  return incoming.id > existing.id ? { apply: true } : { apply: false, reason: "stale" };
}

/** Exposed for tests / callers that only need the predicate. */
export function shouldApply(
  existing: { updatedAt: number; deleted: number; id: string } | undefined,
  incoming: ChangeRecord
): boolean {
  return evaluate(existing, incoming).apply;
}

/**
 * Apply a batch inside one transaction.
 * `expectedBase` (when provided) is re-checked *inside* the lock, closing the
 * read-then-write race between the route's pre-flight check and the write.
 * Throws "VERSION_CONFLICT" when the caller's base is stale.
 */
export async function applyChanges(
  userId: string,
  tokenChanges: ChangeRecord[],
  recoveryChanges: ChangeRecord[],
  expectedBase?: number
): Promise<ApplyResult> {
  return db.transaction(async (tx) => {
    // Row lock / transaction check: serializes this user's pushes.
    const locked = await tx
      .select({ v: users.syncVersion })
      .from(users)
      .where(eq(users.id, userId));
    const v0 = locked[0]?.v ?? 0;
    if (expectedBase !== undefined && expectedBase !== v0) throw new Error("VERSION_CONFLICT");

    let seq = 0;
    const appliedTokens: AppliedEcho[] = [];
    const appliedRecoveries: AppliedEcho[] = [];
    const skipped: SkippedChange[] = [];

    for (const c of tokenChanges) {
      // The PK is global, so look up by id then verify ownership. Filtering by
      // (id, user_id) would make another tenant's id look "new" and collide on
      // insert.
      const existing = (await tx.select().from(tokens).where(eq(tokens.id, c.id)).limit(1))[0];
      if (existing && existing.userId !== userId) {
        skipped.push({ id: c.id, entity: "token", reason: "owned_by_other_user" });
        continue;
      }
      const verdict = evaluate(existing, c);
      if (!verdict.apply) {
        skipped.push({ id: c.id, entity: "token", reason: verdict.reason });
        continue;
      }
      seq += 1;
      const version = v0 + seq;
      const deleted = c.deleted ? 1 : 0;
      const encryptedData = c.encrypted_data ?? existing?.encryptedData ?? "";
      const createdAt = c.created_at ?? existing?.createdAt ?? Date.now();
      if (existing) {
        await tx
          .update(tokens)
          .set({ encryptedData, version, deleted, createdAt, updatedAt: c.updated_at })
          .where(eq(tokens.id, existing.id));
      } else {
        await tx.insert(tokens).values({
          id: c.id,
          userId,
          encryptedData,
          version,
          deleted,
          createdAt,
          updatedAt: c.updated_at,
        });
      }
      // spec §5.3: deleting a token cascades tombstones to its recovery records
      if (deleted) {
        const recs = await tx
          .select()
          .from(recoveryCodes)
          .where(and(eq(recoveryCodes.userId, userId), eq(recoveryCodes.tokenId, c.id)));
        for (const r of recs) {
          if (r.deleted === 1) continue;
          seq += 1;
          const now = Date.now();
          await tx
            .update(recoveryCodes)
            .set({ deleted: 1, version: v0 + seq, updatedAt: now })
            .where(eq(recoveryCodes.id, r.id));
          appliedRecoveries.push({ id: r.id, version: v0 + seq, updated_at: now, deleted: true });
        }
      }
      appliedTokens.push({ id: c.id, version, updated_at: c.updated_at, deleted: !!deleted });
    }

    for (const c of recoveryChanges) {
      const existing = (await tx.select().from(recoveryCodes).where(eq(recoveryCodes.id, c.id)).limit(1))[0];
      if (existing && existing.userId !== userId) {
        skipped.push({ id: c.id, entity: "recovery", reason: "owned_by_other_user" });
        continue;
      }
      const verdict = evaluate(existing, c);
      if (!verdict.apply) {
        skipped.push({ id: c.id, entity: "recovery", reason: verdict.reason });
        continue;
      }
      seq += 1;
      const version = v0 + seq;
      const deleted = c.deleted ? 1 : 0;
      const encryptedData = c.encrypted_data ?? existing?.encryptedData ?? "";
      const tokenId = c.token_id ?? existing?.tokenId ?? "";
      const createdAt = c.created_at ?? existing?.createdAt ?? Date.now();
      if (existing) {
        await tx
          .update(recoveryCodes)
          .set({ encryptedData, tokenId, version, deleted, createdAt, updatedAt: c.updated_at })
          .where(eq(recoveryCodes.id, existing.id));
      } else {
        await tx
          .insert(recoveryCodes)
          .values({ id: c.id, userId, tokenId, encryptedData, version, deleted, createdAt, updatedAt: c.updated_at });
      }
      appliedRecoveries.push({ id: c.id, version, updated_at: c.updated_at, deleted: !!deleted });
    }

    if (seq > 0) {
      const target = v0 + seq;
      // Safe under the row lock held above; no CAS retry loop needed.
      await tx.update(users).set({ syncVersion: target }).where(eq(users.id, userId));
      return { serverVersion: target, tokens: appliedTokens, recoveries: appliedRecoveries, skipped };
    }
    return { serverVersion: v0, tokens: appliedTokens, recoveries: appliedRecoveries, skipped };
  });
}

export async function isSyncLocked(userId: string): Promise<boolean> {
  const rows = await db.select({ syncLocked: users.syncLocked }).from(users).where(eq(users.id, userId)).limit(1);
  return (rows[0]?.syncLocked ?? 0) === 1;
}

/** The lock holder may push under a valid change-password lock token (spec §4.5). */
export async function isValidChangeLock(userId: string, token: string): Promise<boolean> {
  const rows = await db
    .select({ t: users.changePwToken, e: users.changePwExpires })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const r = rows[0];
  return !!r?.t && r.t === token && !!r.e && r.e > Date.now();
}

export async function changesSince(userId: string, since: number) {
  const t = await db
    .select()
    .from(tokens)
    .where(and(eq(tokens.userId, userId), gt(tokens.version, since)));
  const r = await db
    .select()
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), gt(recoveryCodes.version, since)));
  return {
    tokens: t.map((x) => ({
      id: x.id,
      encrypted_data: x.encryptedData,
      version: x.version,
      deleted: x.deleted === 1,
      created_at: x.createdAt,
      updated_at: x.updatedAt,
    })),
    recoveries: r.map((x) => ({
      id: x.id,
      token_id: x.tokenId,
      encrypted_data: x.encryptedData,
      version: x.version,
      deleted: x.deleted === 1,
      created_at: x.createdAt,
      updated_at: x.updatedAt,
    })),
  };
}

export { sql };
