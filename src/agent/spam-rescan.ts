import {
  aggregate,
  loadAllMessages,
  scoreFalsePositiveSpam,
  type MsgRow,
} from "./audit";
import { isMultiTenant } from "../lib/db";
import {
  enqueueReview as enqueueReviewSqlite,
  type ReviewQueueInput,
} from "../lib/analyzer-db";
import {
  enqueueReviewPg,
  loadAllMessagesPg,
} from "../lib/analyzer-db-pg";

export interface SpamRescanResult {
  messagesScanned: number;
  sendersFlagged: number;
  messagesEnqueued: number;
}

export async function runSpamRescan(): Promise<SpamRescanResult> {
  const mt = isMultiTenant();
  const userId = mt ? process.env.DEV_USER_ID : null;
  if (mt && !userId) throw new Error("MULTI_TENANT=true requires DEV_USER_ID");

  const rows: MsgRow[] = mt
    ? ((await loadAllMessagesPg(userId!)) as MsgRow[])
    : loadAllMessages();

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
      const ok = mt ? await enqueueReviewPg(userId!, input) : enqueueReviewSqlite(input);
      if (ok) messagesEnqueued++;
    }
  }

  return { messagesScanned: rows.length, sendersFlagged, messagesEnqueued };
}

// CLI entry — only run when invoked directly.
if (require.main === module) {
  (async () => {
    const mt = isMultiTenant();
    console.log(`Spam re-evaluation starting [${mt ? `multi-tenant user=${process.env.DEV_USER_ID}` : "single-user SQLite"}]...`);
    try {
      const r = await runSpamRescan();
      console.log(`Loaded ${r.messagesScanned} messages.`);
      console.log(`Spam rescan done. ${r.sendersFlagged} sender(s) flagged, ${r.messagesEnqueued} new review row(s).`);
    } catch (err) {
      console.error("Spam rescan failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  })();
}
