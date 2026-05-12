import { NextResponse } from "next/server";
import { getDb } from "@/lib/analyzer-db";

export const dynamic = "force-dynamic";

export function GET() {
  try {
    const db = getDb();

    const topSenders = db.prepare(`
      SELECT
        m.sender_email,
        m.sender_name,
        COUNT(*) as message_count,
        MAX(m.date_received) as last_seen
      FROM messages m
      JOIN mailboxes mb ON m.mailbox_id = mb.id
      WHERE LOWER(mb.name) LIKE '%junk%' OR LOWER(mb.name) LIKE '%spam%'
      GROUP BY m.sender_email
      ORDER BY message_count DESC
      LIMIT 30
    `).all();

    const sampleSubjects = db.prepare(`
      SELECT m.sender_email, m.subject, m.date_received
      FROM messages m
      JOIN mailboxes mb ON m.mailbox_id = mb.id
      WHERE LOWER(mb.name) LIKE '%junk%' OR LOWER(mb.name) LIKE '%spam%'
      ORDER BY m.date_received DESC
      LIMIT 50
    `).all();

    const total = db.prepare(`
      SELECT COUNT(*) as count FROM messages m
      JOIN mailboxes mb ON m.mailbox_id = mb.id
      WHERE LOWER(mb.name) LIKE '%junk%' OR LOWER(mb.name) LIKE '%spam%'
    `).get() as { count: number };

    return NextResponse.json({ topSenders, sampleSubjects, total: total.count });
  } catch {
    return NextResponse.json({ topSenders: [], sampleSubjects: [], total: 0 });
  }
}
