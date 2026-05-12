import { NextResponse } from "next/server";
import { getDb } from "@/lib/analyzer-db";

export const dynamic = "force-dynamic";

export function GET() {
  try {
    const db = getDb();

    const mailboxes = db.prepare(`
      SELECT
        mb.name,
        mb.account,
        mb.message_count,
        mb.unread_count,
        mb.last_scanned_at,
        COUNT(m.id) as scanned_messages,
        SUM(m.size_bytes) as total_size_bytes
      FROM mailboxes mb
      LEFT JOIN messages m ON m.mailbox_id = mb.id
      GROUP BY mb.id
      ORDER BY scanned_messages DESC
    `).all();

    return NextResponse.json({ mailboxes });
  } catch {
    return NextResponse.json({ mailboxes: [] });
  }
}
