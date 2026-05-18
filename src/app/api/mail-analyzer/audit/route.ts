import { NextResponse } from "next/server";
import {
  getDb,
  listAuditFindings,
  getMessageOverrides,
  AuditFindingKind,
} from "@/lib/analyzer-db";
import {
  listAuditFindingsPg,
  getMessageOverridesPg,
  getAuditMessageDetailsPg,
  getLastAuditRunPg,
} from "@/lib/analyzer-db-pg";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
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
    let userId: string | null = null;
    if (isMultiTenant()) {
      const supabase = await createClient();
      const { data: { user }, error } = await supabase.auth.getUser();
      if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      userId = user.id;
    }

    const findings = userId ? await listAuditFindingsPg(userId) : listAuditFindings();

    const allIds = new Set<string>();
    for (const f of findings) for (const id of f.message_ids) allIds.add(id);
    const idList = [...allIds];

    const detailMap = new Map<string, MessageDetail>();
    if (idList.length > 0) {
      let rows: MessageDetail[];
      if (userId) {
        rows = (await getAuditMessageDetailsPg(userId, idList)) as MessageDetail[];
      } else {
        const placeholders = idList.map(() => "?").join(",");
        rows = getDb().prepare(`
          SELECT m.id, m.subject, m.date_received, m.is_read, mb.name AS mailbox_name
          FROM messages m
          JOIN mailboxes mb ON m.mailbox_id = mb.id
          WHERE m.id IN (${placeholders})
        `).all(...idList) as MessageDetail[];
      }
      for (const r of rows) detailMap.set(r.id, { ...r, override: null });
    }

    const grouped: Record<string, ReturnType<typeof shapeFinding>[]> = {};
    for (const kind of ALL_KINDS) grouped[kind] = [];

    for (const f of findings) {
      const overrides = userId
        ? await getMessageOverridesPg(userId, f.kind, f.message_ids)
        : getMessageOverrides(f.kind, f.message_ids);
      const messages = f.message_ids
        .map((id) => {
          const d = detailMap.get(id);
          if (!d) return null;
          return { ...d, override: overrides.get(id) ?? null };
        })
        .filter((m): m is MessageDetail => m !== null);
      grouped[f.kind].push(shapeFinding(f, messages));
    }

    const lastRun = userId
      ? await getLastAuditRunPg(userId)
      : (getDb()
          .prepare(
            "SELECT id, started_at, finished_at, findings_count, status FROM audit_runs ORDER BY id DESC LIMIT 1"
          )
          .get() as
          | { id: number; started_at: string; finished_at: string | null; findings_count: number | null; status: string }
          | undefined) ?? null;

    return NextResponse.json({ findings: grouped, lastRun: lastRun ?? null });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

function shapeFinding(f: ReturnType<typeof listAuditFindings>[number], messages: MessageDetail[]) {
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
    let userId: string | null = null;
    if (isMultiTenant()) {
      const supabase = await createClient();
      const { data: { user }, error } = await supabase.auth.getUser();
      if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      userId = user.id;
    }
    const count = await runAudit(userId);
    return NextResponse.json({ ok: true, findings: count });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
