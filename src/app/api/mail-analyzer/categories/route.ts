import { NextResponse } from "next/server";
import { getDb } from "@/lib/analyzer-db";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { getCategoryRollupPg } from "@/lib/analyzer-db-pg";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (isMultiTenant()) {
      const supabase = await createClient();
      const { data: { user }, error } = await supabase.auth.getUser();
      if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      return NextResponse.json({ categories: await getCategoryRollupPg(user.id) });
    }

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
