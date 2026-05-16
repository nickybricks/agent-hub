import { NextResponse } from "next/server";
import { getDb } from "@/lib/analyzer-db";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { getVolumeByDayPg } from "@/lib/analyzer-db-pg";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (isMultiTenant()) {
      const supabase = await createClient();
      const { data: { user }, error } = await supabase.auth.getUser();
      if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      return NextResponse.json({ rows: await getVolumeByDayPg(user.id) });
    }

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
