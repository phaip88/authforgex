import { db } from "@/db";
import { auditLog, recoveryCodes, refreshTokens, tokens, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { problem, requireAuth, unauthorized, rateLimit, safeEqualHex } from "@/lib/server/http";

// DELETE /api/v1/user { auth_proof } — permanently delete the account and every
// server-side record (spec §9). Requires the auth proof (SHA256 of the Auth Key)
// as a second factor beyond the access token.
export async function DELETE(req: Request) {
  const uid = await requireAuth(req);
  if (!uid) return unauthorized();
  const rl = await rateLimit(`user:delete:${uid}`, 5);
  if (!rl.ok) return problem(429, "rate_limited", "Too many requests", undefined, { "retry-after": String(rl.retryAfterS) });

  const body = (await req.json().catch(() => null)) as { auth_proof?: string } | null;
  const rows = await db.select().from(users).where(eq(users.id, uid)).limit(1);
  const user = rows[0];
  if (!user) return problem(404, "not_found", "Unknown user");
  if (!body?.auth_proof || !safeEqualHex(user.authKeyHash, body.auth_proof.toLowerCase()))
    return problem(401, "invalid_credentials", "Invalid auth proof");

  await db.transaction(async (tx) => {
    await tx.delete(tokens).where(eq(tokens.userId, uid));
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, uid));
    await tx.delete(refreshTokens).where(eq(refreshTokens.userId, uid));
    await tx.delete(auditLog).where(eq(auditLog.userId, uid));
    await tx.delete(users).where(eq(users.id, uid));
  });
  return new Response(null, { status: 204 });
}
