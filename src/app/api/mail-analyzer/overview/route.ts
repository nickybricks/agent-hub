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

    // COUNT(DISTINCT sender_email/mailbox_id) over 41k messages was ~21s.
    // The distinct sets already live in the small senders/mailboxes tables —
    // count those instead; the messages aggregate keeps only index-cheap ops.
    const [msgAgg] = await db.execute(sql`
      SELECT
        COUNT(*) AS total_messages,
        SUM(CASE WHEN is_read = false THEN 1 ELSE 0 END) AS unread_messages,
        MAX(date_received) AS latest_date,
        MIN(date_received) AS earliest_date
      FROM messages
      WHERE user_id = ${userId}
    `);
    const [mbCount] = await db.execute(sql`
      SELECT COUNT(*) AS c FROM mailboxes WHERE user_id = ${userId}
    `);
    const [sndCount] = await db.execute(sql`
      SELECT COUNT(*) AS c FROM senders WHERE user_id = ${userId}
    `);
    const totalsRow = {
      ...(msgAgg as Record<string, unknown>),
      mailbox_count: (mbCount as { c: number })?.c ?? 0,
      sender_count: (sndCount as { c: number })?.c ?? 0,
    };

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
