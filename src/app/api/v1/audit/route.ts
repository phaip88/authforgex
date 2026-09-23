import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { problem, requireAuth, unauthorized, clientIp } from "@/lib/server/http";

const ALLOWED_ACTIONS = new Set([
  "token_create", "token_update", "token_delete",
  "recovery_view", "recovery_copy", "recovery_use", "recovery_create",
  "export", "import", "backup_create",
]);

// POST /api/v1/audit { events: [...] } — client best-effort reporting queue
// (spec §12.6: async, never blocks local usage)
export async function POST(req: Request) {
  const uid = await requireAuth(req);
  if (!uid) return unauthorized();
  const body = (await req.json().catch(() => null)) as {
    events?: { action?: string; ts?: number; details?: Record<string, unknown> }[];
  } | null;
  const ip = clientIp(req);
  const events = (body?.events ?? []).slice(0, 50);
  if (events.length > 0) {
    await db.insert(auditLog).values(
      events
        .filter((e) => e.action && ALLOWED_ACTIONS.has(e.action))
        .map((e) => ({
          userId: uid,
          action: e.action!,
          ipAddress: ip,
          details: e.details ? JSON.stringify(e.details).slice(0, 2000) : null,
          createdAt: typeof e.ts === "number" && e.ts > 0 ? e.ts : Date.now(),
        }))
    );
  }
  return Response.json({ accepted: events.length });
}

// GET /api/v1/audit — last 50 entries for the settings screen
export async function GET(req: Request) {
  const uid = await requireAuth(req);
  if (!uid) return unauthorized();
  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.userId, uid))
    .orderBy(desc(auditLog.createdAt))
    .limit(50);
  return Response.json({
    events: rows.map((r) => ({
      id: r.id,
      action: r.action,
      ip: r.ipAddress,
      details: r.details ? JSON.parse(r.details) : null,
      created_at: r.createdAt,
    })),
  });
}
