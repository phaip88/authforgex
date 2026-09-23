import { problem, requireAuth, unauthorized, rateLimit, tooMany } from "@/lib/server/http";
import {
  applyChanges,
  changesSince,
  currentServerVersion,
  isSyncLocked,
  isValidChangeLock,
  type ChangeRecord,
} from "@/lib/server/sync";

const MAX_BATCH = 500;
const MAX_RECORD_BYTES = 64_000;

// GET /api/v1/sync?since_version=N — incremental pull (spec §8.1).
// `server_version` is this user's private sequence: another tenant's writes
// can never move it, so a client's base_version stays valid until the client
// (or one of its own devices) writes.
export async function GET(req: Request) {
  const uid = await requireAuth(req);
  if (!uid) return unauthorized();

  const rl = await rateLimit(`sync:get:${uid}`, 300);
  if (!rl.ok) return tooMany(rl.retryAfterS);

  const url = new URL(req.url);
  const since = Math.max(0, Number(url.searchParams.get("since_version") ?? 0) || 0);
  const [serverVersion, changes] = await Promise.all([
    currentServerVersion(uid),
    changesSince(uid, since),
  ]);
  return Response.json({ server_version: serverVersion, ...changes });
}

// PUT /api/v1/sync { base_version, tokens[], recoveries[] }
// Atomic: base_version is re-validated *inside* the row lock, so a concurrent
// push from the same user cannot slip between the check and the write.
export async function PUT(req: Request) {
  const uid = await requireAuth(req);
  if (!uid) return unauthorized();

  const rl = await rateLimit(`sync:put:${uid}`, 120);
  if (!rl.ok) return tooMany(rl.retryAfterS);

  if (await isSyncLocked(uid)) {
    // the credential-change lock holder may still push (spec §4.5 step 3)
    const lockHeader = req.headers.get("x-change-lock");
    if (!lockHeader || !(await isValidChangeLock(uid, lockHeader)))
      return problem(423, "sync_locked", "Sync is temporarily locked by a credential change");
  }

  const body = (await req.json().catch(() => null)) as {
    base_version?: number;
    tokens?: ChangeRecord[];
    recoveries?: ChangeRecord[];
  } | null;
  if (!body || typeof body.base_version !== "number" || body.base_version < 0)
    return problem(422, "invalid_request", "base_version is required");

  const tChanges = body.tokens ?? [];
  const rChanges = body.recoveries ?? [];
  if (tChanges.length + rChanges.length > MAX_BATCH)
    return problem(413, "batch_too_large", `At most ${MAX_BATCH} changes per push`);

  for (const c of [...tChanges, ...rChanges]) {
    if (!c || typeof c.id !== "string" || c.id.length === 0 || c.id.length > 64 || typeof c.updated_at !== "number")
      return problem(422, "invalid_record", "Each change needs a valid id and updated_at");
    if (!c.deleted && (typeof c.encrypted_data !== "string" || c.encrypted_data.length > MAX_RECORD_BYTES))
      return problem(422, "invalid_record", "encrypted_data missing or larger than 64KB");
  }

  try {
    const result = await applyChanges(uid, tChanges, rChanges, body.base_version);
    return Response.json({
      new_server_version: result.serverVersion,
      applied: {
        tokens: result.tokens,
        recoveries: result.recoveries,
        total: result.tokens.length + result.recoveries.length,
      },
      // Never silently swallow a rejected change: the client can reconcile.
      skipped: result.skipped,
    });
  } catch (e) {
    if (e instanceof Error && e.message === "VERSION_CONFLICT") {
      const v = await currentServerVersion(uid);
      return problem(409, "version_conflict", "Base version is stale — pull and retry", undefined, {
        "x-server-version": String(v),
      });
    }
    throw e;
  }
}
