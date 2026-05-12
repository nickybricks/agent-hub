import { NextResponse } from "next/server";
import { getDb } from "@/lib/analyzer-db";

export const dynamic = "force-dynamic";

export function GET() {
  try {
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
