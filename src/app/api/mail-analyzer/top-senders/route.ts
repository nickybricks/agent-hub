import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/analyzer-db";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  try {
    const db = getDb();
    const selfEmail = (process.env.IMAP_USER || "").toLowerCase();
    const category = req.nextUrl.searchParams.get("category");

    let categoryClause = "";
    const params: unknown[] = [selfEmail];
    if (category && category !== "all") {
      if (category === "unclassified") {
        categoryClause = "AND s.category IS NULL";
      } else {
        categoryClause = "AND s.category = ?";
        params.push(category);
      }
    }

    const senders = db.prepare(`
      SELECT
        m.sender_email,
        m.sender_name,
        s.domain,
        s.category,
        COUNT(*) as message_count,
        SUM(CASE WHEN m.is_read = 0 THEN 1 ELSE 0 END) as unread_count,
        MAX(m.date_received) as last_seen,
        SUM(CASE WHEN LOWER(mb.name) LIKE '%junk%' OR LOWER(mb.name) LIKE '%spam%' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as junk_pct
      FROM messages m
      JOIN mailboxes mb ON m.mailbox_id = mb.id
      LEFT JOIN senders s ON LOWER(m.sender_email) = s.email
      WHERE LOWER(m.sender_email) != ?
        ${categoryClause}
      GROUP BY m.sender_email
      ORDER BY message_count DESC
      LIMIT 50
    `).all(...params);

    return NextResponse.json({ senders });
  } catch {
    return NextResponse.json({ senders: [] });
  }
}
