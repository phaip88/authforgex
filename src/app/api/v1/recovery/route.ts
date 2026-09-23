import { db } from "@/db";
import { recoveryCodes } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { problem, requireAuth, unauthorized, rateLimit, tooMany, audit } from "@/lib/server/http";
import { applyChanges, type SkippedChange } from "@/lib/server/sync";

function skipProblem(s: SkippedChange) {
  if (s.reason === "owned_by_other_user")
    return problem(409, "id_conflict", "That record id already belongs to another account — generate a new id");
  if (s.reason === "tombstoned")
    return problem(409, "record_deleted", "That record was deleted; create it under a new id");
  return problem(409, "stale_write", "A newer version of this record exists — pull and retry");
}

// GET /api/v1/recovery?token_id=... — ciphertext records (spec §9)
export async function GET(req: Request) {
  const uid = await requireAuth(req);
  if (!uid) return unauthorized();
  const rl = await rateLimit(`recovery:get:${uid}`, 300);
  if (!rl.ok) return tooMany(rl.retryAfterS);

  const tokenId = new URL(req.url).searchParams.get("token_id");
  const rows = tokenId
    ? await db
        .select()
        .from(recoveryCodes)
        .where(and(eq(recoveryCodes.userId, uid), eq(recoveryCodes.tokenId, tokenId)))
    : await db.select().from(recoveryCodes).where(eq(recoveryCodes.userId, uid));
  return Response.json({
    recoveries: rows
      .filter((r) => r.deleted === 0)
      .map((r) => ({
        id: r.id,
        token_id: r.tokenId,
        encrypted_data: r.encryptedData,
        version: r.version,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      })),
  });
}

// POST /api/v1/recovery — upsert one ciphertext record
export async function POST(req: Request) {
  const uid = await requireAuth(req);
  if (!uid) return unauthorized();
  const rl = await rateLimit(`recovery:post:${uid}`, 300);
  if (!rl.ok) return tooMany(rl.retryAfterS);

  const body = (await req.json().catch(() => null)) as {
    id?: string;
    token_id?: string;
    encrypted_data?: string;
    updated_at?: number;
  } | null;
  if (
    !body?.id ||
    body.id.length > 64 ||
    !body.token_id ||
    typeof body.encrypted_data !== "string" ||
    body.encrypted_data.length > 64_000
  )
    return problem(422, "invalid_record", "id, token_id and encrypted_data (<=64KB) are required");

  const result = await applyChanges(uid, [], [
    {
      id: body.id,
      token_id: body.token_id,
      encrypted_data: body.encrypted_data,
      updated_at: body.updated_at ?? Date.now(),
    },
  ]);
  const applied = result.recoveries[0];
  if (!applied) return skipProblem(result.skipped[0] ?? { id: body.id, entity: "recovery", reason: "stale" });

  return Response.json({ id: applied.id, version: applied.version, server_version: result.serverVersion });
}

// DELETE /api/v1/recovery?id=... — soft delete
export async function DELETE(req: Request) {
  const uid = await requireAuth(req);
  if (!uid) return unauthorized();
  const rl = await rateLimit(`recovery:del:${uid}`, 300);
  if (!rl.ok) return tooMany(rl.retryAfterS);

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return problem(422, "invalid_request", "id is required");

  const result = await applyChanges(uid, [], [{ id, deleted: true, updated_at: Date.now() }]);
  const applied = result.recoveries[0];
  if (!applied) {
    const skip = result.skipped[0];
    if (skip?.reason === "tombstoned") return new Response(null, { status: 204 });
    return skipProblem(skip ?? { id, entity: "recovery", reason: "stale" });
  }
  await audit(uid, "recovery_delete", req, { id });
  return Response.json({ id, version: applied.version, server_version: result.serverVersion });
}
