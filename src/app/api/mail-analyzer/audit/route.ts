import { NextResponse } from "next/server";
import type { AuditFinding, AuditFindingKind } from "@/lib/analyzer-db";
import {
  listAuditFindingsPg,
  getMessageOverridesPg,
  getAuditMessageDetailsPg,
  getLastAuditRunPg,
} from "@/lib/analyzer-db-pg";
import { getAuthUser } from "@/lib/auth";
import { runAudit } from "@/agent/audit";

export const dynamic = "force-dynamic";
// runAudit loads the full mailbox and scores it inline; the default function
// timeout is too short for a large account.
export const maxDuration = 300;

interface MessageDetail {
  id: string;
  subject: string | null;
  date_received: string;
  is_read: number;
  mailbox_name: string;
  override: string | null;
}

const ALL_KINDS: AuditFindingKind[] = [
  "phishing_risk",
  "false_positive_spam",
  "false_negative_inbox",
  "hygiene_stale_sender",
  "hygiene_storage_hog",
];

export async function GET() {
  try {
    const auth = await getAuthUser();
    if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const userId = auth.userId;

    const findings = await listAuditFindingsPg(userId);

    const allIds = new Set<string>();
    for (const f of findings) for (const id of f.message_ids) allIds.add(id);
    const idList = [...allIds];

    const detailMap = new Map<string, MessageDetail>();
    if (idList.length > 0) {
      const rows = (await getAuditMessageDetailsPg(userId, idList)) as MessageDetail[];
      for (const r of rows) detailMap.set(r.id, { ...r, override: null });
    }

    const grouped: Record<string, ReturnType<typeof shapeFinding>[]> = {};
    for (const kind of ALL_KINDS) grouped[kind] = [];

    for (const f of findings) {
      const overrides = await getMessageOverridesPg(userId, f.kind, f.message_ids);
      const messages = f.message_ids
        .map((id) => {
          const d = detailMap.get(id);
          if (!d) return null;
          return { ...d, override: overrides.get(id) ?? null };
        })
        .filter((m): m is MessageDetail => m !== null);
      grouped[f.kind].push(shapeFinding(f, messages));
    }

    const lastRun = await getLastAuditRunPg(userId);

    return NextResponse.json({ findings: grouped, lastRun: lastRun ?? null });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

function shapeFinding(f: AuditFinding, messages: MessageDetail[]) {
  return {
    id: f.id,
    kind: f.kind,
    sender_email: f.sender_email,
    suggested_action: f.suggested_action,
    score: f.score,
    reasoning: f.reasoning,
    created_at: f.created_at,
    message_count: f.message_ids.length,
    messages,
  };
}

export async function POST() {
  try {
    const auth = await getAuthUser();
    if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const count = await runAudit(auth.userId);
    return NextResponse.json({ ok: true, findings: count });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
