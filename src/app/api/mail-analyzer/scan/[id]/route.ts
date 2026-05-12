import { NextResponse } from "next/server";
import { getDb } from "@/lib/analyzer-db";

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

  const row = getDb().prepare(`
    SELECT id, started_at, finished_at, messages_scanned, watermark_date, status, error
    FROM scan_runs WHERE id = ?
  `).get(numId);

  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(row);
}
