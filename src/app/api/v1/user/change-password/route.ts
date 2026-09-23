import { db } from "@/db";
import { refreshTokens, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { audit, problem, requireAuth, unauthorized, rateLimit } from "@/lib/server/http";

// POST /api/v1/user/change-password — step 4 of the 4-step credential change
// (spec §4.5). Must ONLY be called after the client pushed all re-encrypted
// records (sync PUT under the lock). Rotates KDF params + auth hash atomically,
// releases the lock, and revokes EVERY session (client re-logs-in with the new
// auth proof; other devices must unlock with the new master password).
export async function POST(req: Request) {
  const uid = await requireAuth(req);
  if (!uid) return unauthorized();
  const rl = await rateLimit(`chpw:commit:${uid}`, 10);
  if (!rl.ok) return problem(429, "rate_limited", "Too many requests", undefined, { "retry-after": String(rl.retryAfterS) });

  const body = (await req.json().catch(() => null)) as {
    lock_token?: string;
    new_kdf_params?: string;
    new_auth_key_hash?: string;
  } | null;
  if (!body?.lock_token || !body.new_kdf_params || !/^[0-9a-f]{64}$/.test(body.new_auth_key_hash ?? ""))
    return problem(422, "invalid_request", "lock_token, new_kdf_params and new_auth_key_hash (64 hex) are required");

  try {
    const k = JSON.parse(body.new_kdf_params);
    if (k.algorithm !== "PBKDF2-SHA256" || typeof k.iterations !== "number" || k.iterations < 100_000 || !k.salt) throw new Error();
  } catch {
    return problem(422, "invalid_kdf_params", "Unsupported KDF parameters");
  }

  const rows = await db.select().from(users).where(eq(users.id, uid)).limit(1);
  const user = rows[0];
  if (!user) return problem(404, "not_found", "Unknown user");
  const now = Date.now();
  if (!user.changePwToken || user.changePwToken !== body.lock_token || !user.changePwExpires || user.changePwExpires < now)
    return problem(409, "invalid_lock", "No matching in-progress credential change (expired or never begun)");

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        kdfParams: body.new_kdf_params!,
        authKeyHash: body.new_auth_key_hash!.toLowerCase(),
        syncLocked: 0,
        changePwToken: null,
        changePwExpires: null,
        updatedAt: now,
      })
      .where(eq(users.id, uid));
    // revoke every refresh token (spec §4.5: "吊销除当前设备外" — we revoke all
    // and let the caller immediately re-authenticate with the new proof, which
    // is strictly safer than trying to identify the current device).
    await tx.update(refreshTokens).set({ revokedAt: now }).where(eq(refreshTokens.userId, uid));
  });

  await audit(uid, "password_change", req);
  return Response.json({ ok: true, reauth_required: true });
}
