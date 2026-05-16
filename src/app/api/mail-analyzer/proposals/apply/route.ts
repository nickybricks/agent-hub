import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import {
  getFolderRule,
  getMessagesMatchingRule,
  getProposedFolderByPath,
  setFolderRuleStatus,
  setProposedFolderStatus,
  touchRuleApplied,
  logMoves,
  upsertMailbox,
  updateMessageMailbox,
  writeMemory,
} from "@/lib/analyzer-db";
import {
  getFolderRulePg,
  getMessagesMatchingRulePg,
  getProposedFolderByPathPg,
  setFolderRuleStatusPg,
  setProposedFolderStatusPg,
  touchRuleAppliedPg,
  logMovesPg,
  upsertMailboxPg,
  updateMessageMailboxPg,
  writeMemoryPg,
} from "@/lib/analyzer-db-pg";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { createMailProvider, readMailConfig } from "@/lib/mail-provider";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const body = (await req.json()) as { ruleId: number; makeRule?: boolean };
  if (!body.ruleId) return NextResponse.json({ error: "ruleId required" }, { status: 400 });

  let userId: string | null = null;
  if (isMultiTenant()) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    userId = user.id;
  }

  const getRule = async (id: number) =>
    userId ? getFolderRulePg(userId, id) : getFolderRule(id);
  const matchingMessages = async (r: Parameters<typeof getMessagesMatchingRule>[0]) =>
    userId ? getMessagesMatchingRulePg(userId, r) : getMessagesMatchingRule(r);
  const setRuleStatus = async (id: number, status: "accepted" | "rejected") =>
    userId ? setFolderRuleStatusPg(userId, id, status) : setFolderRuleStatus(id, status);
  const touchRule = async (id: number) =>
    userId ? touchRuleAppliedPg(userId, id) : touchRuleApplied(id);
  const folderByPath = async (path: string) =>
    userId ? getProposedFolderByPathPg(userId, path) : getProposedFolderByPath(path);
  const setFolderStatus = async (id: number, status: "created") =>
    userId ? setProposedFolderStatusPg(userId, id, status) : setProposedFolderStatus(id, status);
  const upsertMb = async (info: { name: string; account: string; messageCount: number; unreadCount: number }) =>
    userId ? upsertMailboxPg(userId, info) : upsertMailbox(info);
  const updateMsgMb = async (messageId: string, mailboxId: number) =>
    userId ? updateMessageMailboxPg(userId, messageId, mailboxId) : updateMessageMailbox(messageId, mailboxId);
  const logMv = async (entries: Parameters<typeof logMoves>[0]) => {
    if (userId) {
      await logMovesPg(userId, entries.map((e) => ({ ...e, rule_id: e.rule_id ?? null, reason: e.reason ?? null, error: e.error ?? null })));
    } else {
      logMoves(entries);
    }
  };
  const memo = async (input: Parameters<typeof writeMemory>[0]) =>
    userId ? writeMemoryPg(userId, input) : writeMemory(input);

  const rule = await getRule(body.ruleId);
  if (!rule) return NextResponse.json({ error: "rule not found" }, { status: 404 });
  if (!rule.target_folder) return NextResponse.json({ error: "rule has no target_folder" }, { status: 400 });

  const matches = await matchingMessages(rule);
  if (matches.length === 0) {
    // Nothing to move, still mark the rule accepted/rejected and folder created.
    if (body.makeRule !== false) await setRuleStatus(rule.id, "accepted");
    else await setRuleStatus(rule.id, "rejected");
    return NextResponse.json({ ok: true, moved: 0, failed: 0, batch_id: null });
  }

  const cfg = readMailConfig();
  const provider = await createMailProvider();
  await provider.open();

  const batchId = randomUUID();
  // Account label for logging.
  const account =
    cfg.imap?.user ??
    process.env.IMAP_USER ??
    "default";
  const providerKind = cfg.provider ?? "imap";

  let moved = 0;
  let failed = 0;

  try {
    // Ensure target folder exists.
    await provider.createMailbox(rule.target_folder);
    // Record the destination mailbox so dashboard counts include it.
    const destMailboxId = await upsertMb({
      name: rule.target_folder,
      account,
      messageCount: 0,
      unreadCount: 0,
    });

    // Group by source mailbox — providers need a single source per call.
    const byMailbox = new Map<string, typeof matches>();
    for (const m of matches) {
      const arr = byMailbox.get(m.mailbox_name) ?? [];
      arr.push(m);
      byMailbox.set(m.mailbox_name, arr);
    }

    for (const [fromMailbox, msgs] of byMailbox) {
      const ids = msgs.map((m) => m.id);
      const results = await provider.moveMessages(ids, fromMailbox, rule.target_folder);
      const okIds = new Set(results.filter((r) => r.ok).map((r) => r.messageId));

      await logMv(
        results.map((r) => {
          const msg = msgs.find((m) => m.id === r.messageId);
          return {
            message_id: r.messageId,
            from_mailbox: fromMailbox,
            to_mailbox: rule.target_folder!,
            account,
            provider: providerKind,
            rule_id: rule.id,
            batch_id: batchId,
            reason: `proposal rule #${rule.id}: ${rule.match_type}=${rule.match_value}`,
            status: r.ok ? "applied" : "failed",
            error: r.error ?? null,
          };
        })
      );

      // Re-point moved messages in SQLite so the dashboard reflects reality without a rescan.
      for (const m of msgs) {
        if (okIds.has(m.id)) {
          await updateMsgMb(m.id, destMailboxId);
          moved++;
        } else {
          failed++;
        }
      }
    }

    // Update rule and folder status.
    if (body.makeRule !== false) {
      await setRuleStatus(rule.id, "accepted");
    } else {
      await setRuleStatus(rule.id, "rejected");
    }
    await touchRule(rule.id);

    const folder = await folderByPath(rule.target_folder);
    if (folder && folder.status !== "created") {
      await setFolderStatus(folder.id, "created");
    }
  } finally {
    await provider.close();
  }

  await memo({
    kind: "apply_action",
    key: rule.target_folder,
    source: "user_decision",
    content: `User applied rule #${rule.id} (${rule.match_type}=${rule.match_value} → ${rule.target_folder}): ${moved} moved, ${failed} failed. Persistent rule: ${body.makeRule !== false ? "yes" : "no (one-off backfill)"}. Batch ${batchId}.`,
  });

  return NextResponse.json({ ok: true, moved, failed, batch_id: batchId });
}
