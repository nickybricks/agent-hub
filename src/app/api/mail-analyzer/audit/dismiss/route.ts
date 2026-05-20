import { NextRequest, NextResponse } from "next/server";
import { dismissAuditFindingPg, writeMemoryPg } from "@/lib/analyzer-db-pg";
import { getAuthUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { id?: number } | null;
  if (!body?.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = auth.userId;

  await dismissAuditFindingPg(userId, body.id);
  await writeMemoryPg(userId, {
    kind: "audit_decision",
    source: "user_decision",
    content: `User dismissed audit finding #${body.id}.`,
  });
  return NextResponse.json({ ok: true });
}
