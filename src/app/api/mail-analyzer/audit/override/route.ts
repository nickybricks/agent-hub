import { NextRequest, NextResponse } from "next/server";
import type { AuditFindingKind } from "@/lib/analyzer-db";
import { setMessageOverridePg, writeMemoryPg } from "@/lib/analyzer-db-pg";
import { getAuthUser } from "@/lib/auth";

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

  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = auth.userId;

  await setMessageOverridePg(userId, body.messageId, body.kind, body.decision);
  await writeMemoryPg(userId, {
    kind: "audit_decision",
    key: body.messageId,
    source: "user_decision",
    content: `User decision on audit finding "${body.kind}" for message ${body.messageId}: "${body.decision}".`,
  });
  return NextResponse.json({ ok: true });
}
