import { randomBytes } from "node:crypto";
import { db } from "@/db";
import { users } from "@/db/schema";
import { and, eq, or, lt, sql } from "drizzle-orm";
import { audit, problem, requireAuth, unauthorized, rateLimit, tooMany } from "@/lib/server/http";

// POST /api/v1/user/change-password/begin — step 1 of the 4-step credential
// change (spec §4.5): engage the sync lock so other devices get 423 until we
// finish pushing re-encrypted records and rotate the KDF parameters.
//
// The lock is taken with a single conditional UPDATE. Reading `sync_locked`
// and then writing it in a second statement would let two devices both observe
// "unlocked" and both mint a token, so the loser's re-encryption push could be
// committed against the winner's rotation.
export async function POST(req: Request) {
  const uid = await requireAuth(req);
  if (!uid) return unauthorized();
  const rl = await rateLimit(`chpw:begin:${uid}`, 10);
  if (!rl.ok) return tooMany(rl.retryAfterS);

  const now = Date.now();
  const lockToken = randomBytes(24).toString("hex");

  // Acquire only if free, or if a previous lock has expired (10 min TTL).
  const acquired = await db
    .update(users)
    .set({ syncLocked: 1, changePwToken: lockToken, changePwExpires: now + 10 * 60_000, updatedAt: now })
    .where(
      and(
        eq(users.id, uid),
        or(eq(users.syncLocked, 0), lt(users.changePwExpires, now), sql`${users.changePwExpires} IS NULL`)
      )
    )
    .returning({ id: users.id });

  if (acquired.length === 0) {
    // Either the user vanished, or another device holds a live lock.
    const exists = await db.select({ id: users.id }).from(users).where(eq(users.id, uid)).limit(1);
    if (exists.length === 0) return problem(404, "not_found", "Unknown user");
    return problem(
      409,
      "already_locked",
      "A credential change is already in progress. It auto-expires within 10 minutes."
    );
  }

  await audit(uid, "password_change_begin", req);
  return Response.json({ lock_token: lockToken, expires_in: 600 });
}
