import { randomUUID } from "crypto";
import { createMailProvider } from "../lib/mail-provider";
import type {
  ReviewQueueInput,
  TriageCandidate,
} from "../lib/analyzer-db";
import {
  enqueueReviewPg,
  failTriageRunPg,
  findRuleForSenderPg,
  finishTriageRunPg,
  getLastTriageWatermarkPg,
  getMessagesForTriagePg,
  listAuditFindingSendersPg,
  logMovesPg,
  startTriageRunPg,
  touchRuleAppliedPg,
  updateMessageMailboxPg,
  upsertMailboxPg,
  writeMemoryPg,
} from "../lib/analyzer-db-pg";
import { getMailCredentials } from "../lib/credentials";

const BATCH_LIMIT = Number(process.env.TRIAGE_BATCH_LIMIT ?? 500);

interface RuleMatchedMove {
  msg: TriageCandidate;
  toMailbox: string;
  ruleId: number;
  ruleSummary: string;
}

export interface TriageResult {
  processed: number;
  moved: number;
  queued: number;
}

function isSpamMailbox(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("spam") || n.includes("junk");
}

function isInboxMailbox(name: string): boolean {
  return name.toLowerCase() === "inbox";
}

/** Run triage for a tenant. */
export async function runTriage(
  userId: string,
  opts: { dryRun?: boolean } = {},
): Promise<TriageResult> {
  const dryRun = !!opts.dryRun;
  console.log(`Triage starting${dryRun ? " (dry-run)" : ""} [user=${userId}]...`);

  const watermark = await getLastTriageWatermarkPg(userId);
  console.log(`Watermark: ${watermark ?? "(none — processing all)"}`);

  const candidates = await getMessagesForTriagePg(userId, watermark, BATCH_LIMIT);
  console.log(`Found ${candidates.length} candidate messages.`);
  if (candidates.length === 0) {
    if (!dryRun) {
      const id = await startTriageRunPg(userId);
      await finishTriageRunPg(userId, id, { processed: 0, moved: 0, queued: 0 }, watermark);
    }
    return { processed: 0, moved: 0, queued: 0 };
  }

  const fpSpamSenders = await listAuditFindingSendersPg(userId, "false_positive_spam");
  const fnInboxSenders = await listAuditFindingSendersPg(userId, "false_negative_inbox");

  const moves: RuleMatchedMove[] = [];
  const queueInputs: ReviewQueueInput[] = [];

  let highWatermark = watermark;
  for (const msg of candidates) {
    if (!highWatermark || msg.scanned_at > highWatermark) highWatermark = msg.scanned_at;
    const senderLower = msg.sender_email.toLowerCase();

    const rule = await findRuleForSenderPg(userId, msg.sender_email);
    if (rule && rule.status === "accepted" && rule.action === "route_to" && rule.target_folder) {
      if (msg.mailbox_name === rule.target_folder) continue;
      moves.push({
        msg,
        toMailbox: rule.target_folder,
        ruleId: rule.id,
        ruleSummary: `rule #${rule.id}: ${rule.match_type}=${rule.match_value} → ${rule.target_folder}`,
      });
      continue;
    }

    if (isSpamMailbox(msg.mailbox_name) && fpSpamSenders.has(senderLower)) {
      queueInputs.push({
        message_id: msg.id,
        mailbox_id: msg.mailbox_id,
        reason: "probably_not_spam",
        suggested_action: "not_spam",
      });
      continue;
    }
    if (isInboxMailbox(msg.mailbox_name) && fnInboxSenders.has(senderLower)) {
      queueInputs.push({
        message_id: msg.id,
        mailbox_id: msg.mailbox_id,
        reason: "probably_spam",
        suggested_action: "mark_spam",
      });
      continue;
    }

    if (rule && rule.status === "proposed") {
      queueInputs.push({
        message_id: msg.id,
        mailbox_id: msg.mailbox_id,
        reason: "proposed_rule",
        suggested_action: "confirm_move",
        suggested_target: rule.target_folder,
      });
      continue;
    }

    queueInputs.push({
      message_id: msg.id,
      mailbox_id: msg.mailbox_id,
      reason: msg.category ? "low_confidence" : "unknown_sender",
    });
  }

  console.log(
    `Plan: ${moves.length} auto-move, ${queueInputs.length} to review queue, ${
      candidates.length - moves.length - queueInputs.length
    } skipped.`,
  );

  if (dryRun) {
    for (const m of moves.slice(0, 10)) {
      console.log(`  MOVE  ${m.msg.id}  ${m.msg.mailbox_name} → ${m.toMailbox}  (${m.ruleSummary})`);
    }
    for (const q of queueInputs.slice(0, 10)) {
      console.log(`  QUEUE ${q.message_id}  reason=${q.reason}  suggested=${q.suggested_action ?? "-"}`);
    }
    return { processed: candidates.length, moved: 0, queued: 0 };
  }

  const runId = await startTriageRunPg(userId);
  let moved = 0;
  let queued = 0;

  try {
    for (const q of queueInputs) {
      if (await enqueueReviewPg(userId, q)) queued++;
    }

    if (moves.length > 0) {
      const cfg = await getMailCredentials(userId);
      const account = cfg.imap?.user ?? process.env.IMAP_USER ?? "default";
      const providerKind = cfg.provider ?? "imap";
      const batchId = randomUUID();

      const provider = await createMailProvider(userId);
      await provider.open();
      try {
        const byPair = new Map<string, RuleMatchedMove[]>();
        for (const m of moves) {
          const key = `${m.msg.mailbox_name}→${m.toMailbox}`;
          const arr = byPair.get(key) ?? [];
          arr.push(m);
          byPair.set(key, arr);
        }

        for (const [, group] of byPair) {
          const from = group[0].msg.mailbox_name;
          const to = group[0].toMailbox;
          await provider.createMailbox(to);
          const destMailboxId = await upsertMailboxPg(userId, {
            name: to,
            account,
            messageCount: 0,
            unreadCount: 0,
          });

          const ids = group.map((g) => g.msg.id);
          const results = await provider.moveMessages(ids, from, to);
          const okIds = new Set(results.filter((r) => r.ok).map((r) => r.messageId));

          await logMovesPg(
            userId,
            results.map((r) => {
              const g = group.find((x) => x.msg.id === r.messageId)!;
              return {
                message_id: r.messageId,
                from_mailbox: from,
                to_mailbox: to,
                account,
                provider: providerKind,
                rule_id: g.ruleId,
                batch_id: batchId,
                reason: `triage auto-move (${g.ruleSummary})`,
                status: r.ok ? ("applied" as const) : ("failed" as const),
                error: r.error ?? null,
              };
            }),
          );

          for (const g of group) {
            if (okIds.has(g.msg.id)) {
              await updateMessageMailboxPg(userId, g.msg.id, destMailboxId);
              await touchRuleAppliedPg(userId, g.ruleId);
              await writeMemoryPg(userId, {
                kind: "apply_action",
                key: to,
                source: "self",
                content: `Triage daemon auto-moved message ${g.msg.id} (${g.msg.sender_email}) ${from} → ${to} via ${g.ruleSummary}. Batch ${batchId}.`,
              });
              moved++;
            }
          }
        }
      } finally {
        await provider.close();
      }
    }

    await finishTriageRunPg(userId, runId, { processed: candidates.length, moved, queued }, highWatermark);
    console.log(`Triage done. moved=${moved} queued=${queued} processed=${candidates.length}`);
    return { processed: candidates.length, moved, queued };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failTriageRunPg(userId, runId, msg);
    throw new Error(`Triage failed: ${msg}`);
  }
}

// CLI entry — only run when invoked directly.
if (require.main === module) {
  (async () => {
    const userId = process.env.DEV_USER_ID;
    if (!userId) {
      console.error("DEV_USER_ID env var required.");
      process.exit(1);
    }
    try {
      await runTriage(userId, { dryRun: process.argv.includes("--dry-run") });
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  })();
}
