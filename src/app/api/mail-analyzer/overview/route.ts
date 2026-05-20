import { NextResponse } from "next/server";
import { getDrizzleDb } from "@/lib/db";
import { sql } from "drizzle-orm";
import { getAuthUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const auth = await getAuthUser();
    if (!auth) return NextResponse.json({ totals: null, lastRun: null }, { status: 401 });
    const userId = auth.userId;

    const db = getDrizzleDb();

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
    console.error("overview error", e);
    return NextResponse.json({ totals: null, lastRun: null });
  }
}
