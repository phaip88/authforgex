import { db } from "@/db";
import { refreshTokens } from "@/db/schema";
import { eq } from "drizzle-orm";
import { problem, rateLimit, clientIp, audit } from "@/lib/server/http";
import {
  signAccessToken,
  generateRefreshToken,
  sha256hex,
  REFRESH_TTL_MS,
} from "@/lib/server/jwt";

// POST /api/v1/auth/refresh { refresh_token } — rotation (spec §4.4).
// Reuse of a revoked token => replay detected => revoke all sessions.
export async function POST(req: Request) {
  const ip = clientIp(req);
  const rl = await rateLimit(`refresh:${ip}`, 60);
  if (!rl.ok)
    return problem(429, "rate_limited", "Too many requests", undefined, {
      "retry-after": String(rl.retryAfterS),
    });

  const body = (await req.json().catch(() => null)) as { refresh_token?: string } | null;
  const token = body?.refresh_token;
  if (!token) return problem(422, "invalid_request", "refresh_token is required");

  const hash = sha256hex(token);
  const rows = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hash)).limit(1);
  const row = rows[0];
  const now = Date.now();

  if (!row) return problem(401, "invalid_refresh", "Invalid refresh token");

  if (row.revokedAt || row.expiresAt < now) {
    // replay / expired-token reuse: revoke the user's whole session set
    await db.update(refreshTokens).set({ revokedAt: now }).where(eq(refreshTokens.userId, row.userId));
    await audit(row.userId, "replay_detected", req);
    return problem(401, "replay_detected", "Session revoked due to token reuse");
  }

  // rotate
  await db.update(refreshTokens).set({ revokedAt: now }).where(eq(refreshTokens.tokenHash, hash));
  const newRefresh = generateRefreshToken();
  await db.insert(refreshTokens).values({
    tokenHash: sha256hex(newRefresh),
    userId: row.userId,
    deviceName: row.deviceName,
    expiresAt: now + REFRESH_TTL_MS,
    createdAt: now,
  });
  const access = await signAccessToken(row.userId);
  await audit(row.userId, "refresh", req);
  return Response.json({ access_token: access, expires_in: 900, refresh_token: newRefresh });
}
