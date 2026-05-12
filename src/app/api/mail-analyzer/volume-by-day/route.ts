import { NextResponse } from "next/server";
import { getDb } from "@/lib/analyzer-db";

export const dynamic = "force-dynamic";

export function GET() {
  try {
    const db = getDb();

    const rows = db.prepare(`
      SELECT
        SUBSTR(date_received, 1, 10) as day,
        COUNT(*) as message_count
      FROM messages
      WHERE date_received >= DATE('now', '-90 days')
      GROUP BY day
      ORDER BY day ASC
    `).all();

    return NextResponse.json({ rows });
  } catch {
    return NextResponse.json({ rows: [] });
  }
}
