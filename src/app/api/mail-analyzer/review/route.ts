import { NextResponse } from "next/server";
import { isMultiTenant, getDrizzleDb } from "@/lib/db";
import { sql } from "drizzle-orm";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  if (isMultiTenant()) {
    return getMultiTenantReview();
  }
  return getSqliteReview();
}

async function getSqliteReview() {
  try {
    const { listReviewQueue } = await import("@/lib/analyzer-db");
    return NextResponse.json({ items: listReviewQueue("pending", 200) });
  } catch (e) {
    console.error("review list error", e);
    return NextResponse.json({ items: [] });
  }
}

async function getMultiTenantReview() {
  try {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ items: [] }, { status: 401 });

    const db = getDrizzleDb();
    const rows = await db.execute(sql`
      SELECT rq.id, rq.message_id, rq.mailbox_id, rq.reason,
             rq.suggested_action, rq.suggested_target,
             rq.status, rq.decided_at, rq.decided_action, rq.created_at,
             m.subject, m.sender_email, m.sender_name, m.date_received,
             mb.name AS mailbox_name, mb.account
      FROM review_queue rq
      JOIN messages m ON rq.message_id = m.id AND m.user_id = ${user.id}
      LEFT JOIN mailboxes mb ON rq.mailbox_id = mb.id
      WHERE rq.user_id = ${user.id} AND rq.status = 'pending'
      ORDER BY rq.created_at DESC
      LIMIT 200
    `);
    return NextResponse.json({ items: rows });
  } catch (e) {
    console.error("multi-tenant review list error", e);
    return NextResponse.json({ items: [] });
  }
}
