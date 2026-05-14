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
} from "@/lib/analyzer-db";
import { createMailProvider, readMailConfig } from "@/lib/mail-provider";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const body = (await req.json()) as { ruleId: number; makeRule?: boolean };
  if (!body.ruleId) return NextResponse.json({ error: "ruleId required" }, { status: 400 });

  const rule = getFolderRule(body.ruleId);
  if (!rule) return NextResponse.json({ error: "rule not found" }, { status: 404 });
  if (!rule.target_folder) return NextResponse.json({ error: "rule has no target_folder" }, { status: 400 });

  const matches = getMessagesMatchingRule(rule);
  if (matches.length === 0) {
    // Nothing to move, still mark the rule accepted/rejected and folder created.
    if (body.makeRule !== false) setFolderRuleStatus(rule.id, "accepted");
    else setFolderRuleStatus(rule.id, "rejected");
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
    const destMailboxId = upsertMailbox({
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

      logMoves(
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
          updateMessageMailbox(m.id, destMailboxId);
          moved++;
        } else {
          failed++;
        }
      }
    }

    // Update rule and folder status.
    if (body.makeRule !== false) {
      setFolderRuleStatus(rule.id, "accepted");
    } else {
      setFolderRuleStatus(rule.id, "rejected");
    }
    touchRuleApplied(rule.id);

    const folder = getProposedFolderByPath(rule.target_folder);
    if (folder && folder.status !== "created") {
      setProposedFolderStatus(folder.id, "created");
    }
  } finally {
    await provider.close();
  }

  return NextResponse.json({ ok: true, moved, failed, batch_id: batchId });
}
