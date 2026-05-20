import { aggregate, scoreFalsePositiveSpam, type MsgRow } from "./audit";
import type { ReviewQueueInput } from "../lib/analyzer-db";
import { enqueueReviewPg, loadAllMessagesPg } from "../lib/analyzer-db-pg";

export interface SpamRescanResult {
  messagesScanned: number;
  sendersFlagged: number;
  messagesEnqueued: number;
}

export async function runSpamRescan(userId: string): Promise<SpamRescanResult> {
  const rows = (await loadAllMessagesPg(userId)) as MsgRow[];
  const senders = aggregate(rows);
  let sendersFlagged = 0;
  let messagesEnqueued = 0;

  for (const sender of senders.values()) {
    const fp = scoreFalsePositiveSpam(sender);
    if (!fp) continue;
    sendersFlagged++;
    for (const m of sender.inSpam) {
      const input: ReviewQueueInput = {
        message_id: m.id,
        mailbox_id: m.mailbox_id,
        reason: "probably_not_spam",
        suggested_action: "not_spam",
      };
      const ok = await enqueueReviewPg(userId, input);
      if (ok) messagesEnqueued++;
    }
  }

  return { messagesScanned: rows.length, sendersFlagged, messagesEnqueued };
}

// CLI entry — only run when invoked directly.
if (require.main === module) {
  (async () => {
    const userId = process.env.DEV_USER_ID;
    if (!userId) {
      console.error("DEV_USER_ID env var required.");
      process.exit(1);
    }
    console.log(`Spam re-evaluation starting [user=${userId}]...`);
    try {
      const r = await runSpamRescan(userId);
      console.log(`Loaded ${r.messagesScanned} messages.`);
      console.log(`Spam rescan done. ${r.sendersFlagged} sender(s) flagged, ${r.messagesEnqueued} new review row(s).`);
    } catch (err) {
      console.error("Spam rescan failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  })();
}
