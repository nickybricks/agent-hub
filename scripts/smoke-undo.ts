/**
 * Undo a batch via the same path the /api/mail-analyzer/history/undo route uses.
 * Verifies the loop end-to-end without needing an authenticated dev-server session.
 *
 * Usage: npx tsx --env-file=.env.local scripts/smoke-undo.ts <batchId>
 */

import { createMailProvider } from "../src/lib/mail-provider";
import {
  getMailboxIdByNamePg, getMovesByBatchPg, markMovesUndonePg,
  updateMessageMailboxPg, writeMemoryPg,
} from "../src/lib/analyzer-db-pg";

const batchId = process.argv[2];
const USER_ID = process.env.DEV_USER_ID;
if (!batchId || !USER_ID) { console.error("usage: smoke-undo <batchId>"); process.exit(1); }

async function main() {
  const moves = await getMovesByBatchPg(USER_ID!, batchId);
  const applied = moves.filter((m) => m.status === "applied");
  console.log(`Batch ${batchId}: ${moves.length} move(s), ${applied.length} applied`);
  if (applied.length === 0) { console.log("Nothing to undo."); return; }

  const provider = await createMailProvider();
  await provider.open();
  const undoneIds: number[] = [];
  try {
    const byPair = new Map<string, typeof applied>();
    for (const m of applied) {
      const key = `${m.to_mailbox}→${m.from_mailbox}`;
      const arr = byPair.get(key) ?? [];
      arr.push(m);
      byPair.set(key, arr);
    }
    for (const [, group] of byPair) {
      const src = group[0].to_mailbox;
      const dst = group[0].from_mailbox;
      const account = group[0].account;
      const ids = group.map((g) => g.message_id);
      console.log(`  reversing ${ids.length}: ${src} → ${dst}`);
      const results = await provider.moveMessages(ids, src, dst);
      const okIds = new Set(results.filter((r) => r.ok).map((r) => r.messageId));
      const dstId = await getMailboxIdByNamePg(USER_ID!, dst, account);
      for (const m of group) {
        if (okIds.has(m.message_id)) {
          undoneIds.push(m.id);
          if (dstId !== null) await updateMessageMailboxPg(USER_ID!, m.message_id, dstId);
        }
      }
      console.log(`  ${[...okIds].length}/${ids.length} ok`);
    }
  } finally {
    await provider.close();
  }
  if (undoneIds.length > 0) {
    await markMovesUndonePg(USER_ID!, undoneIds);
    await writeMemoryPg(USER_ID!, {
      kind: "apply_action", key: batchId, source: "user_decision",
      content: `Smoke undo: batch ${batchId}, reverted ${undoneIds.length}/${applied.length}.`,
    });
  }
  console.log(`Undone: ${undoneIds.length}/${applied.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
