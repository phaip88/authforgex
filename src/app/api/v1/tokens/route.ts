import { db } from "@/db";
import { tokens } from "@/db/schema";
import { eq } from "drizzle-orm";
import { problem, requireAuth, unauthorized, rateLimit, tooMany } from "@/lib/server/http";
import { applyChanges, type SkippedChange } from "@/lib/server/sync";

/** Turn a skipped write into an honest error instead of a fake 200. */
function skipProblem(s: SkippedChange) {
  if (s.reason === "owned_by_other_user")
    return problem(409, "id_conflict", "That record id already belongs to another account — generate a new id");
  if (s.reason === "tombstoned")
    return problem(409, "record_deleted", "That record was deleted; create it under a new id");
  return problem(409, "stale_write", "A newer version of this record exists — pull and retry");
}

// GET /api/v1/tokens — ciphertext records for the user (spec §9)
export async function GET(req: Request) {
  const uid = await requireAuth(req);
  if (!uid) return unauthorized();
  const rl = await rateLimit(`tokens:get:${uid}`, 300);
  if (!rl.ok) return tooMany(rl.retryAfterS);

  const all = new URL(req.url).searchParams.get("all") === "true";
  const rows = await db.select().from(tokens).where(eq(tokens.userId, uid));
  return Response.json({
    tokens: rows
      .filter((r) => all || r.deleted === 0)
      .map((r) => ({
        id: r.id,
        encrypted_data: r.encryptedData,
        version: r.version,
        deleted: r.deleted === 1,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
      })),
  });
}

// POST /api/v1/tokens — upsert one ciphertext record via the sync engine
export async function POST(req: Request) {
  const uid = await requireAuth(req);
  if (!uid) return unauthorized();
  const rl = await rateLimit(`tokens:post:${uid}`, 300);
  if (!rl.ok) return tooMany(rl.retryAfterS);

  const body = (await req.json().catch(() => null)) as {
    id?: string;
    encrypted_data?: string;
    updated_at?: number;
  } | null;
  if (!body?.id || body.id.length > 64 || typeof body.encrypted_data !== "string" || body.encrypted_data.length > 64_000)
    return problem(422, "invalid_record", "id (<=64 chars) and encrypted_data (<=64KB) are required");

  const result = await applyChanges(
    uid,
    [{ id: body.id, encrypted_data: body.encrypted_data, updated_at: body.updated_at ?? Date.now() }],
    []
  );
  const applied = result.tokens[0];
  if (!applied) return skipProblem(result.skipped[0] ?? { id: body.id, entity: "token", reason: "stale" });

  return Response.json({ id: applied.id, version: applied.version, server_version: result.serverVersion });
}

// DELETE /api/v1/tokens?id=... — soft delete (cascades to recovery records)
export async function DELETE(req: Request) {
  const uid = await requireAuth(req);
  if (!uid) return unauthorized();
  const rl = await rateLimit(`tokens:del:${uid}`, 300);
  if (!rl.ok) return tooMany(rl.retryAfterS);

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return problem(422, "invalid_request", "id is required");

  const result = await applyChanges(uid, [{ id, deleted: true, updated_at: Date.now() }], []);
  const applied = result.tokens[0];
  if (!applied) {
    const skip = result.skipped[0];
    // Deleting an already-deleted record is idempotent, not an error.
    if (skip?.reason === "tombstoned") return new Response(null, { status: 204 });
    return skipProblem(skip ?? { id, entity: "token", reason: "stale" });
  }
  return Response.json({ id, version: applied.version, server_version: result.serverVersion });
}
