import { db } from "@/db";
import { refreshTokens } from "@/db/schema";
import { eq } from "drizzle-orm";
import { audit } from "@/lib/server/http";
import { sha256hex } from "@/lib/server/jwt";

// POST /api/v1/auth/logout { refresh_token } -> 204
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { refresh_token?: string } | null;
  if (body?.refresh_token) {
    const hash = sha256hex(body.refresh_token);
    const rows = await db
      .update(refreshTokens)
      .set({ revokedAt: Date.now() })
      .where(eq(refreshTokens.tokenHash, hash))
      .returning({ userId: refreshTokens.userId });
    if (rows[0]) await audit(rows[0].userId, "logout", req);
  }
  return new Response(null, { status: 204 });
}
