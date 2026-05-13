import { NextRequest, NextResponse } from "next/server";
import { dismissAuditFinding } from "@/lib/analyzer-db";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { id?: number } | null;
  if (!body?.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  dismissAuditFinding(body.id);
  return NextResponse.json({ ok: true });
}
