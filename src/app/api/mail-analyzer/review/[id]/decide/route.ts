import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getAuthUser } from "@/lib/auth";
import { createMailProvider } from "@/lib/mail-provider";
import { getMailCredentials } from "@/lib/credentials";
import type { ReviewAction } from "@/lib/analyzer-db";
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

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: idStr } = await params;
  const id = Number(idStr);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as DecideBody;
  if (!body.action) return NextResponse.json({ error: "action required" }, { status: 400 });

  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = auth.userId;

  const item = await getReviewQueueItemPg(userId, id);
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
    target = await findMailboxNamePg(userId, (n) => /spam|junk/i.test(n));
    if (!target) return NextResponse.json({ error: "no spam mailbox found" }, { status: 400 });
  } else if (body.action === "not_spam") {
    target = await findMailboxNamePg(userId, (n) => /^inbox$/i.test(n));
    if (!target) return NextResponse.json({ error: "no inbox mailbox found" }, { status: 400 });
  }

  const cfg = await getMailCredentials(userId);
  const account = cfg.imap?.user ?? process.env.IMAP_USER ?? "default";
  const providerKind = cfg.provider ?? "imap";
  const batchId = randomUUID();
  const from = item.mailbox_name;

  let moved = false;
  let moveError: string | null = null;

  if (target && target !== from) {
    const provider = await createMailProvider(userId);
    await provider.open();
    try {
      await provider.createMailbox(target);
      const destMailboxId = await upsertMailboxPg(userId, {
        name: target,
        account,
        messageCount: 0,
        unreadCount: 0,
      });
      const [result] = await provider.moveMessages([item.message_id], from, target);
      const ok = result?.ok === true;
      await logMovesPg(userId, [
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
        await updateMessageMailboxPg(userId, item.message_id, destMailboxId);
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
    ruleId = await insertFolderRulePg(userId, {
      match_type: matchType,
      match_value: matchValue,
      action: "route_to",
      target_folder: target,
      source: "user",
      status: "accepted",
    });
  }

  await writeMemoryPg(userId, {
    kind: "user_pref",
    key: item.sender_email,
    source: "user_decision",
    content: `Review #${id}: action=${body.action} target=${target ?? "-"} sender=${item.sender_email} from=${from}${ruleId ? ` rule=${ruleId}` : ""}`,
  });
  if (moved) {
    await writeMemoryPg(userId, {
      kind: "apply_action",
      key: target,
      source: "user_decision",
      content: `Review #${id} moved ${item.message_id} (${item.sender_email}) ${from} → ${target}. Batch ${batchId}.`,
    });
  }

  await setReviewDecidedPg(userId, id, body.action);

  return NextResponse.json({
    ok: true,
    moved,
    rule_id: ruleId,
    batch_id: moved ? batchId : null,
    error: moveError,
  });
}
