import { NextRequest, NextResponse } from "next/server";
import { dismissAuditFinding, writeMemory } from "@/lib/analyzer-db";
import { dismissAuditFindingPg, writeMemoryPg } from "@/lib/analyzer-db-pg";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as { id?: number } | null;
  if (!body?.id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const memo = {
    kind: "audit_decision" as const,
    source: "user_decision" as const,
    content: `User dismissed audit finding #${body.id}.`,
  };

  if (isMultiTenant()) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    await dismissAuditFindingPg(user.id, body.id);
    await writeMemoryPg(user.id, memo);
  } else {
    dismissAuditFinding(body.id);
    writeMemory(memo);
  }
  return NextResponse.json({ ok: true });
}
