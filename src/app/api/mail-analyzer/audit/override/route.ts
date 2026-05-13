import { NextRequest, NextResponse } from "next/server";
import { setMessageOverride, AuditFindingKind } from "@/lib/analyzer-db";

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
  setMessageOverride(body.messageId, body.kind, body.decision);
  return NextResponse.json({ ok: true });
}
