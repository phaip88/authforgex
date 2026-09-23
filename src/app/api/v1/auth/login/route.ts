import { db } from "@/db";
import { refreshTokens } from "@/db/schema";
import {
  problem,
  rateLimit,
  clientIp,
  audit,
  getUserByEmail,
  safeEqualHex,
  checkLoginBackoff,
  recordLoginFailure,
  resetLoginFailures,
} from "@/lib/server/http";
import {
  signAccessToken,
  generateRefreshToken,
  sha256hex,
  REFRESH_TTL_MS,
} from "@/lib/server/jwt";

// POST /api/v1/auth/login { email, auth_proof, device_name }
// auth_proof = SHA256(Auth Key); unified 401 error prevents enumeration.
export async function POST(req: Request) {
  try {
    const dbg = (m: string) => process.env.AF_DEBUG_FLOW && console.log(`[login] ${m} ${Date.now()}`);
    dbg("start");
    const ip = clientIp(req);
    const rlIp = await rateLimit(`login:ip:${ip}`, 10);
    if (!rlIp.ok)
      return problem(429, "rate_limited", "Too many login attempts", undefined, {
        "retry-after": String(rlIp.retryAfterS),
      });

    const body = (await req.json().catch(() => null)) as {
      email?: string;
      auth_proof?: string;
      device_name?: string;
    } | null;
    const email = body?.email?.trim().toLowerCase();
    const proof = body?.auth_proof?.toLowerCase();
    if (!email || !proof) return problem(422, "invalid_request", "email and auth_proof are required");

    dbg("after-rl-ip");
    const rlEmail = await rateLimit(`login:email:${email}`, 5);
    if (!rlEmail.ok)
      return problem(429, "rate_limited", "Too many login attempts", undefined, {
        "retry-after": String(rlEmail.retryAfterS),
      });

    dbg("after-rl-email");
    const backoff = await checkLoginBackoff(email);
    if (backoff > 0)
      return problem(429, "login_backoff", "Account temporarily locked after failed attempts", undefined, {
        "retry-after": String(backoff),
      });

    dbg("after-backoff");
    const user = await getUserByEmail(email);
    // constant-shape comparison even for unknown emails (no branch-length oracle)
    const DUMMY = "0".repeat(64);
    dbg("after-user");
    const ok = !!user && safeEqualHex(user?.authKeyHash ?? DUMMY, proof);
    if (!ok) {
      await recordLoginFailure(email);
      if (user) await audit(user.id, "login_failed", req);
      // unified error — do not distinguish unknown email / wrong password
      return problem(401, "invalid_credentials", "Invalid email or master password");
    }

    await dbg("after-safeequal");
    resetLoginFailures(email);
    dbg("after-reset");
    const now = Date.now();
    const access = await signAccessToken(user.id);
    const refresh = generateRefreshToken();
    dbg("before-rt-insert");
    await db.insert(refreshTokens).values({
      tokenHash: sha256hex(refresh),
      userId: user.id,
      deviceName: body?.device_name?.slice(0, 120) ?? null,
      expiresAt: now + REFRESH_TTL_MS,
      createdAt: now,
    });
    dbg("before-audit");
    await audit(user.id, "login", req, { device: body?.device_name });
    dbg("before-response");

    return Response.json({
      access_token: access,
      expires_in: 900,
      refresh_token: refresh,
      user: { id: user.id, email: user.email },
      kdf_params: user.kdfParams,
      settings_enc: user.settingsEnc,
      session_mode: "normal",
    });
  } catch (err: any) {
    console.error("[LOGIN API ERROR]:", err);
    return problem(
      500,
      "internal_error",
      err?.message || "Internal server error during login"
    );
  }
}
