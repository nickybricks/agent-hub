import { NextResponse } from "next/server";
import { getDb } from "@/lib/analyzer-db";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { listMailboxesPg } from "@/lib/analyzer-db-pg";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (isMultiTenant()) {
      const supabase = await createClient();
      const { data: { user }, error } = await supabase.auth.getUser();
      if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      return NextResponse.json({ mailboxes: await listMailboxesPg(user.id) });
    }

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
