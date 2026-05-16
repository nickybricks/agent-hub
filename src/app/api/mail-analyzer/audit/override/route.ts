import { NextRequest, NextResponse } from "next/server";
import { setMessageOverride, AuditFindingKind, writeMemory } from "@/lib/analyzer-db";
import { setMessageOverridePg, writeMemoryPg } from "@/lib/analyzer-db-pg";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const VALID_KINDS: AuditFindingKind[] = [
  "false_positive_spam",
  "false_negative_inbox",
  "phishing_risk",
  "hygiene_stale_sender",
  "hygiene_storage_hog",
];
const VALID_DECISIONS = ["include", "exclude", "agree"] as const;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null) as
    | { messageId?: string; kind?: AuditFindingKind; decision?: "include" | "exclude" | "agree" }
    | null;
  if (!body?.messageId || !body.kind || !body.decision) {
    return NextResponse.json({ error: "messageId, kind, decision required" }, { status: 400 });
  }
  if (!VALID_KINDS.includes(body.kind)) {
    return NextResponse.json({ error: "invalid kind" }, { status: 400 });
  }
  if (!VALID_DECISIONS.includes(body.decision)) {
    return NextResponse.json({ error: "invalid decision" }, { status: 400 });
  }
  const memo = {
    kind: "audit_decision" as const,
    key: body.messageId,
    source: "user_decision" as const,
    content: `User decision on audit finding "${body.kind}" for message ${body.messageId}: "${body.decision}".`,
  };

  if (isMultiTenant()) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    await setMessageOverridePg(user.id, body.messageId, body.kind, body.decision);
    await writeMemoryPg(user.id, memo);
  } else {
    setMessageOverride(body.messageId, body.kind, body.decision);
    writeMemory(memo);
  }
  return NextResponse.json({ ok: true });
}
