import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { problem, rateLimit, clientIp, fakeKdfParams } from "@/lib/server/http";

// POST /api/v1/auth/prelogin { email } -> { kdf_params }
// Returns real KDF params for existing accounts; deterministic fake params
// otherwise (anti-enumeration, spec §4.4).
export async function POST(req: Request) {
  try {
    const ip = clientIp(req);
    const rl = await rateLimit(`prelogin:${ip}`, 30);
    if (!rl.ok)
      return problem(429, "rate_limited", "Too many requests", undefined, {
        "retry-after": String(rl.retryAfterS),
      });

    const body = (await req.json().catch(() => null)) as { email?: string } | null;
    const email = body?.email?.trim().toLowerCase();
    if (!email) return problem(422, "invalid_request", "email is required");

    const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
    const user = rows[0];
    return Response.json({ kdf_params: user ? user.kdfParams : fakeKdfParams(email) });
  } catch (err: any) {
    console.error("[PRELOGIN API ERROR]:", err);
    return problem(
      500,
      "internal_error",
      err?.message || "Internal server error during prelogin"
    );
  }
}
