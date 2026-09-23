import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { users, refreshTokens } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  problem,
  rateLimit,
  clientIp,
  audit,
} from "@/lib/server/http";
import {
  signAccessToken,
  generateRefreshToken,
  sha256hex,
  REFRESH_TTL_MS,
} from "@/lib/server/jwt";

// POST /api/v1/auth/register { email, kdf_params, auth_key_hash, device_name }
// auth_key_hash = SHA256(Auth Key) computed client-side (spec §4.3).
export async function POST(req: Request) {
  try {
    const ip = clientIp(req);
    const rl = await rateLimit(`register:${ip}`, 5, 3600_000);
    if (!rl.ok)
      return problem(429, "rate_limited", "Too many registrations", undefined, {
        "retry-after": String(rl.retryAfterS),
      });

    const body = (await req.json().catch(() => null)) as {
      email?: string;
      kdf_params?: string;
      auth_key_hash?: string;
      device_name?: string;
    } | null;

    const email = body?.email?.trim().toLowerCase();
    const kdfParams = body?.kdf_params;
    const authKeyHash = body?.auth_key_hash?.toLowerCase();

    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return problem(422, "invalid_email", "A valid email is required");
    if (!/^[0-9a-f]{64}$/.test(authKeyHash ?? ""))
      return problem(422, "invalid_auth_key_hash", "auth_key_hash must be 64-char hex");
    try {
      const k = JSON.parse(kdfParams ?? "");
      if (k.algorithm !== "PBKDF2-SHA256" || typeof k.iterations !== "number" || k.iterations < 100_000 || !k.salt)
        throw new Error();
    } catch {
      return problem(422, "invalid_kdf_params", "Unsupported KDF parameters");
    }

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing.length > 0)
      return problem(409, "email_taken", "This email is already registered");

    const now = Date.now();
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email,
      authKeyHash: authKeyHash!,
      kdfParams: kdfParams!,
      createdAt: now,
      updatedAt: now,
    });

    const access = await signAccessToken(userId);
    const refresh = generateRefreshToken();
    await db.insert(refreshTokens).values({
      tokenHash: sha256hex(refresh),
      userId,
      deviceName: body?.device_name?.slice(0, 120) ?? null,
      expiresAt: now + REFRESH_TTL_MS,
      createdAt: now,
    });

    await audit(userId, "register", req, { device: body?.device_name });
    return Response.json({
      access_token: access,
      expires_in: 900,
      refresh_token: refresh,
      user: { id: userId, email },
      kdf_params: kdfParams,
      session_mode: "normal",
    });
  } catch (err: any) {
    console.error("[REGISTER API ERROR]:", err);
    return problem(
      500,
      "internal_error",
      err?.message || "Internal server error during registration"
    );
  }
}
