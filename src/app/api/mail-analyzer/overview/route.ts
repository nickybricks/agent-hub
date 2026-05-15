import { NextResponse } from "next/server";
import { isMultiTenant, getDrizzleDb } from "@/lib/db";
import { sql } from "drizzle-orm";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  if (isMultiTenant()) {
    return getMultiTenantOverview();
  }
  return getSqliteOverview();
}

async function getSqliteOverview() {
  try {
    const { getDb } = await import("@/lib/analyzer-db");
    const db = getDb();

    const totals = db.prepare(`
      SELECT
        COUNT(*) as total_messages,
        SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) as unread_messages,
        COUNT(DISTINCT mailbox_id) as mailbox_count,
        COUNT(DISTINCT sender_email) as sender_count,
        MAX(date_received) as latest_date,
        MIN(date_received) as earliest_date
      FROM messages
    `).get() as Record<string, unknown>;

    const lastRun = db.prepare(`
      SELECT started_at, finished_at, messages_scanned, watermark_date, status
      FROM scan_runs ORDER BY id DESC LIMIT 1
    `).get();

    return NextResponse.json({ totals, lastRun });
  } catch {
    return NextResponse.json({ totals: null, lastRun: null });
  }
}

async function getMultiTenantOverview() {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ totals: null, lastRun: null }, { status: 401 });
    }

    const db = getDrizzleDb();
    const userId = user.id;

    const [totalsRow] = await db.execute(sql`
      SELECT
        COUNT(*) AS total_messages,
        SUM(CASE WHEN is_read = false THEN 1 ELSE 0 END) AS unread_messages,
        COUNT(DISTINCT mailbox_id) AS mailbox_count,
        COUNT(DISTINCT sender_email) AS sender_count,
        MAX(date_received) AS latest_date,
        MIN(date_received) AS earliest_date
      FROM messages
      WHERE user_id = ${userId}
    `);

    const [lastRun] = await db.execute(sql`
      SELECT started_at, finished_at, messages_scanned, watermark_date, status
      FROM scan_runs
      WHERE user_id = ${userId}
      ORDER BY id DESC LIMIT 1
    `);

    return NextResponse.json({ totals: totalsRow ?? null, lastRun: lastRun ?? null });
  } catch (e) {
    console.error("multi-tenant overview error", e);
    return NextResponse.json({ totals: null, lastRun: null });
  }
}
