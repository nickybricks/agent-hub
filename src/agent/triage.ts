import { randomUUID } from "crypto";
import { createMailProvider, readMailConfig } from "../lib/mail-provider";
import { isMultiTenant } from "../lib/db";
import {
  enqueueReview as enqueueReviewSqlite,
  failTriageRun as failTriageRunSqlite,
  findRuleForSender as findRuleForSenderSqlite,
  finishTriageRun as finishTriageRunSqlite,
  getLastTriageWatermark as getLastTriageWatermarkSqlite,
  getMessagesForTriage as getMessagesForTriageSqlite,
  listAuditFindings,
  logMoves as logMovesSqlite,
  startTriageRun as startTriageRunSqlite,
  touchRuleApplied as touchRuleAppliedSqlite,
  updateMessageMailbox as updateMessageMailboxSqlite,
  upsertMailbox as upsertMailboxSqlite,
  writeMemory as writeMemorySqlite,
  type ReviewQueueInput,
  type TriageCandidate,
  type FolderRule,
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

const BATCH_LIMIT = Number(process.env.TRIAGE_BATCH_LIMIT ?? 500);
const MT = isMultiTenant();

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

/**
 * Run triage. In multi-tenant mode `userId` is required and all reads/writes
 * are scoped to that user; in single-user mode pass undefined (SQLite).
 */
export async function runTriage(
  userId: string | undefined,
  opts: { dryRun?: boolean } = {},
): Promise<TriageResult> {
  if (MT && !userId) throw new Error("MULTI_TENANT=true requires a userId");

  // Per-user dispatchers — closures over userId so concurrent runs stay isolated.
  const getLastWatermark = (): Promise<string | null> =>
    MT ? getLastTriageWatermarkPg(userId!) : Promise.resolve(getLastTriageWatermarkSqlite());
  const getCandidates = (since: string | null, limit: number): Promise<TriageCandidate[]> =>
    MT ? getMessagesForTriagePg(userId!, since, limit) : Promise.resolve(getMessagesForTriageSqlite(since, limit));
  const ruleForSender = (email: string): Promise<FolderRule | null> =>
    MT ? findRuleForSenderPg(userId!, email) : Promise.resolve(findRuleForSenderSqlite(email));
  const findingSenders = async (kind: "false_positive_spam" | "false_negative_inbox"): Promise<Set<string>> => {
    if (MT) return listAuditFindingSendersPg(userId!, kind);
    return new Set(
      listAuditFindings(kind).map((f) => f.sender_email?.toLowerCase()).filter((e): e is string => !!e),
    );
  };
  const enqueue = (input: ReviewQueueInput): Promise<boolean> =>
    MT ? enqueueReviewPg(userId!, input) : Promise.resolve(enqueueReviewSqlite(input));
  const startRun = (): Promise<number> =>
    MT ? startTriageRunPg(userId!) : Promise.resolve(startTriageRunSqlite());
  const finishRun = async (id: number, counts: TriageResult, watermark: string | null) => {
    if (MT) await finishTriageRunPg(userId!, id, counts, watermark);
    else finishTriageRunSqlite(id, counts, watermark);
  };
  const failRun = async (id: number, error: string) => {
    if (MT) await failTriageRunPg(userId!, id, error);
    else failTriageRunSqlite(id, error);
  };
  const upsertMb = (info: { name: string; account: string; messageCount: number; unreadCount: number }): Promise<number> =>
    MT ? upsertMailboxPg(userId!, info) : Promise.resolve(upsertMailboxSqlite(info));
  const logMv = async (entries: Parameters<typeof logMovesSqlite>[0]): Promise<void> => {
    if (MT) await logMovesPg(userId!, entries.map((e) => ({ ...e, rule_id: e.rule_id ?? null, reason: e.reason ?? null, error: e.error ?? null })));
    else logMovesSqlite(entries);
  };
  const updateMsgMb = async (messageId: string, mailboxId: number): Promise<void> => {
    if (MT) await updateMessageMailboxPg(userId!, messageId, mailboxId);
    else updateMessageMailboxSqlite(messageId, mailboxId);
  };
  const touchRule = async (id: number): Promise<void> => {
    if (MT) await touchRuleAppliedPg(userId!, id);
    else touchRuleAppliedSqlite(id);
  };
  const memo = (input: Parameters<typeof writeMemorySqlite>[0]): Promise<number> =>
    MT ? writeMemoryPg(userId!, input) : Promise.resolve(writeMemorySqlite(input));

  const dryRun = !!opts.dryRun;
  console.log(`Triage starting${dryRun ? " (dry-run)" : ""} [${MT ? `multi-tenant user=${userId}` : "single-user SQLite"}]...`);

  const watermark = await getLastWatermark();
  console.log(`Watermark: ${watermark ?? "(none — processing all)"}`);

  const candidates = await getCandidates(watermark, BATCH_LIMIT);
  console.log(`Found ${candidates.length} candidate messages.`);
  if (candidates.length === 0) {
    if (!dryRun) {
      const id = await startRun();
      await finishRun(id, { processed: 0, moved: 0, queued: 0 }, watermark);
    }
    return { processed: 0, moved: 0, queued: 0 };
  }

  const fpSpamSenders = await findingSenders("false_positive_spam");
  const fnInboxSenders = await findingSenders("false_negative_inbox");

  const moves: RuleMatchedMove[] = [];
  const queueInputs: ReviewQueueInput[] = [];

  let highWatermark = watermark;
  for (const msg of candidates) {
    if (!highWatermark || msg.scanned_at > highWatermark) highWatermark = msg.scanned_at;
    const senderLower = msg.sender_email.toLowerCase();

    const rule = await ruleForSender(msg.sender_email);
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

  const runId = await startRun();
  let moved = 0;
  let queued = 0;

  try {
    for (const q of queueInputs) {
      if (await enqueue(q)) queued++;
    }

    if (moves.length > 0) {
      const cfg = MT
        ? await (await import("../lib/credentials")).getMailCredentials(userId!)
        : readMailConfig();
      const account = cfg.imap?.user ?? process.env.IMAP_USER ?? "default";
      const providerKind = cfg.provider ?? "imap";
      const batchId = randomUUID();

      const provider = await createMailProvider(MT ? userId : undefined);
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
          const destMailboxId = await upsertMb({ name: to, account, messageCount: 0, unreadCount: 0 });

          const ids = group.map((g) => g.msg.id);
          const results = await provider.moveMessages(ids, from, to);
          const okIds = new Set(results.filter((r) => r.ok).map((r) => r.messageId));

          await logMv(
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
              await updateMsgMb(g.msg.id, destMailboxId);
              await touchRule(g.ruleId);
              await memo({
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

    await finishRun(runId, { processed: candidates.length, moved, queued }, highWatermark);
    console.log(`Triage done. moved=${moved} queued=${queued} processed=${candidates.length}`);
    return { processed: candidates.length, moved, queued };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failRun(runId, msg);
    throw new Error(`Triage failed: ${msg}`);
  }
}

// CLI entry — only run when invoked directly.
if (require.main === module) {
  (async () => {
    const userId = MT ? process.env.DEV_USER_ID : undefined;
    if (MT && !userId) {
      console.error("MULTI_TENANT=true requires DEV_USER_ID env var.");
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
