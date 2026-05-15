import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { createMailProvider, readMailConfig } from "@/lib/mail-provider";
import {
  getDb,
  getReviewQueueItem,
  insertFolderRule,
  logMoves,
  setReviewDecided,
  updateMessageMailbox,
  upsertMailbox,
  writeMemory,
  type ReviewAction,
  type ReviewQueueRich,
} from "@/lib/analyzer-db";
import {
  findMailboxNamePg,
  getReviewQueueItemPg,
  insertFolderRulePg,
  logMovesPg,
  setReviewDecidedPg,
  updateMessageMailboxPg,
  upsertMailboxPg,
  writeMemoryPg,
} from "@/lib/analyzer-db-pg";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface DecideBody {
  action: ReviewAction;
  target?: string;
  ruleMatchType?: "sender_email" | "sender_domain";
}

function findMailboxNameSqlite(predicate: (name: string) => boolean): string | null {
  const rows = getDb().prepare(`SELECT name FROM mailboxes ORDER BY id`).all() as { name: string }[];
  return rows.find((r) => predicate(r.name))?.name ?? null;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: idStr } = await params;
  const id = Number(idStr);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as DecideBody;
  if (!body.action) return NextResponse.json({ error: "action required" }, { status: 400 });

  // Resolve tenant + storage path.
  let userId: string | null = null;
  if (isMultiTenant()) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    userId = user.id;
  }

  // Backend-specific helpers bound to userId (or null = SQLite).
  const getItem = async (): Promise<ReviewQueueRich | null> =>
    userId ? getReviewQueueItemPg(userId, id) : getReviewQueueItem(id);
  const findMailbox = async (pred: (name: string) => boolean): Promise<string | null> =>
    userId ? findMailboxNamePg(userId, pred) : findMailboxNameSqlite(pred);
  const upsertMb = async (info: { name: string; account: string; messageCount: number; unreadCount: number }) =>
    userId ? upsertMailboxPg(userId, info) : upsertMailbox(info);
  const logMvAsync = async (entries: Parameters<typeof logMoves>[0]) => {
    if (userId) {
      await logMovesPg(userId, entries.map((e) => ({ ...e, rule_id: e.rule_id ?? null, reason: e.reason ?? null, error: e.error ?? null })));
    } else {
      logMoves(entries);
    }
  };
  const updateMsgMb = async (messageId: string, mailboxId: number) =>
    userId ? updateMessageMailboxPg(userId, messageId, mailboxId) : updateMessageMailbox(messageId, mailboxId);
  const memo = async (input: Parameters<typeof writeMemory>[0]) =>
    userId ? writeMemoryPg(userId, input) : writeMemory(input);
  const insertRule = async (rule: Parameters<typeof insertFolderRule>[0]) =>
    userId ? insertFolderRulePg(userId, rule) : insertFolderRule(rule);
  const markDecided = async (action: ReviewAction) =>
    userId ? setReviewDecidedPg(userId, id, action) : setReviewDecided(id, action);

  const item = await getItem();
  if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (item.status !== "pending") return NextResponse.json({ error: "already decided" }, { status: 409 });

  // Resolve destination.
  let target: string | null = null;
  if (body.action === "confirm_move") {
    target = body.target ?? item.suggested_target;
    if (!target) return NextResponse.json({ error: "target required" }, { status: 400 });
  } else if (body.action === "create_rule") {
    target = body.target ?? null;
    if (!target) return NextResponse.json({ error: "target required for create_rule" }, { status: 400 });
  } else if (body.action === "mark_spam") {
    target = await findMailbox((n) => /spam|junk/i.test(n));
    if (!target) return NextResponse.json({ error: "no spam mailbox found" }, { status: 400 });
  } else if (body.action === "not_spam") {
    target = await findMailbox((n) => /^inbox$/i.test(n));
    if (!target) return NextResponse.json({ error: "no inbox mailbox found" }, { status: 400 });
  }

  const cfg = readMailConfig();
  const account = cfg.imap?.user ?? process.env.IMAP_USER ?? "default";
  const providerKind = cfg.provider ?? "imap";
  const batchId = randomUUID();
  const from = item.mailbox_name;

  let moved = false;
  let moveError: string | null = null;

  if (target && target !== from) {
    const provider = await createMailProvider();
    await provider.open();
    try {
      await provider.createMailbox(target);
      const destMailboxId = await upsertMb({ name: target, account, messageCount: 0, unreadCount: 0 });
      const [result] = await provider.moveMessages([item.message_id], from, target);
      const ok = result?.ok === true;
      await logMvAsync([
        {
          message_id: item.message_id,
          from_mailbox: from,
          to_mailbox: target,
          account,
          provider: providerKind,
          rule_id: null,
          batch_id: batchId,
          reason: `review decision: ${body.action}`,
          status: ok ? "applied" : "failed",
          error: result?.error ?? null,
        },
      ]);
      if (ok) {
        await updateMsgMb(item.message_id, destMailboxId);
        moved = true;
      } else {
        moveError = result?.error ?? "move failed";
      }
    } finally {
      await provider.close();
    }
  }

  let ruleId: number | null = null;
  if (body.action === "create_rule" && target) {
    const matchType = body.ruleMatchType ?? "sender_email";
    const matchValue =
      matchType === "sender_email"
        ? item.sender_email
        : item.sender_email.split("@")[1] ?? item.sender_email;
    ruleId = await insertRule({
      match_type: matchType,
      match_value: matchValue,
      action: "route_to",
      target_folder: target,
      source: "user",
      status: "accepted",
    });
  }

  await memo({
    kind: "user_pref",
    key: item.sender_email,
    source: "user_decision",
    content: `Review #${id}: action=${body.action} target=${target ?? "-"} sender=${item.sender_email} from=${from}${ruleId ? ` rule=${ruleId}` : ""}`,
  });
  if (moved) {
    await memo({
      kind: "apply_action",
      key: target,
      source: "user_decision",
      content: `Review #${id} moved ${item.message_id} (${item.sender_email}) ${from} → ${target}. Batch ${batchId}.`,
    });
  }

  await markDecided(body.action);

  return NextResponse.json({
    ok: true,
    moved,
    rule_id: ruleId,
    batch_id: moved ? batchId : null,
    error: moveError,
  });
}
