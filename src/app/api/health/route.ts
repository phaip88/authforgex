import { db } from "@/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.run(sql`select 1`);
    return Response.json({ ok: true, version: "1.0.0", service: "authforge", d1_ready: true });
  } catch (err) {
    console.error("[HEALTH ROUTE ERROR]:", err);
    return Response.json({ ok: false, version: "1.0.0", error: String(err) }, { status: 500 });
  }
}
