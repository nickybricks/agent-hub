import { NextResponse } from "next/server";
import { getDb } from "@/lib/analyzer-db";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { getScanRunPg } from "@/lib/analyzer-db-pg";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isFinite(numId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  let row: unknown;
  if (isMultiTenant()) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    row = await getScanRunPg(user.id, numId);
  } else {
    row = getDb().prepare(`
      SELECT id, started_at, finished_at, messages_scanned, watermark_date, status, error
      FROM scan_runs WHERE id = ?
    `).get(numId);
  }

  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(row);
}
