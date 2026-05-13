import { NextResponse } from "next/server";
import { getDb } from "@/lib/analyzer-db";

export const dynamic = "force-dynamic";

export function GET() {
  try {
    const db = getDb();
    const selfEmail = (process.env.IMAP_USER || "").toLowerCase();

    const rows = db.prepare(`
      SELECT
        COALESCE(s.category, 'unclassified') as category,
        COUNT(DISTINCT s.email) as sender_count,
        COUNT(m.id) as message_count
      FROM senders s
      LEFT JOIN messages m ON LOWER(m.sender_email) = s.email
      WHERE s.email != ?
      GROUP BY COALESCE(s.category, 'unclassified')
      ORDER BY message_count DESC
    `).all(selfEmail);

    return NextResponse.json({ categories: rows });
  } catch {
    return NextResponse.json({ categories: [] });
  }
}
