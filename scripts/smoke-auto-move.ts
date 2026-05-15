/**
 * Smoke-test the daemon's auto-move path on a single accepted rule, then verify
 * undo. Runs against Postgres in MT mode (reads DEV_USER_ID). Same code paths
 * as triage.ts — just scoped to one rule so we don't wait for the daemon to
 * walk the whole mailbox.
 *
 * Usage: npx tsx --env-file=.env.local scripts/smoke-auto-move.ts <ruleId>
 */

import { randomUUID } from "crypto";
import { createMailProvider, readMailConfig } from "../src/lib/mail-provider";
import {
  logMovesPg, touchRuleAppliedPg, updateMessageMailboxPg, upsertMailboxPg, writeMemoryPg,
} from "../src/lib/analyzer-db-pg";
import postgres from "postgres";

const ruleId = Number(process.argv[2]);
if (!Number.isFinite(ruleId)) { console.error("usage: smoke-auto-move <ruleId>"); process.exit(1); }
const USER_ID = process.env.DEV_USER_ID;
if (!USER_ID) { console.error("DEV_USER_ID required"); process.exit(1); }
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error("DATABASE_URL required"); process.exit(1); }

const pg = postgres(DATABASE_URL, { max: 1 });

async function main() {
  const [rule] = await pg`
    SELECT id, match_type, match_value, target_folder, status, action
    FROM folder_rules WHERE id = ${ruleId} AND user_id = ${USER_ID!}
  `;
  if (!rule) throw new Error("rule not found");
  if (rule.status !== "accepted") throw new Error(`rule status is ${rule.status}, expected accepted`);
  if (!rule.target_folder) throw new Error("rule has no target_folder");
  console.log(`Rule: ${rule.match_type}=${rule.match_value} → ${rule.target_folder}`);

  const condition = rule.match_type === "sender_email"
    ? pg`LOWER(m.sender_email) = ${rule.match_value}`
    : pg`LOWER(SUBSTR(m.sender_email, POSITION('@' IN m.sender_email)+1)) = ${rule.match_value}`;

  const messages = await pg`
    SELECT m.id, m.sender_email, mb.name AS mailbox_name, mb.account
    FROM messages m JOIN mailboxes mb ON m.mailbox_id = mb.id
    WHERE m.user_id = ${USER_ID!} AND ${condition} AND mb.name != ${rule.target_folder}
  `;
  type Msg = { id: string; sender_email: string; mailbox_name: string; account: string };
  const msgs = messages as unknown as Msg[];
  console.log(`Candidates: ${msgs.length}`);
  if (msgs.length === 0) { console.log("Nothing to move."); await pg.end(); return; }

  const cfg = readMailConfig();
  const account = cfg.imap?.user ?? process.env.IMAP_USER ?? "default";
  const providerKind = cfg.provider ?? "imap";
  const batchId = randomUUID();
  console.log(`Batch: ${batchId}`);

  const provider = await createMailProvider();
  await provider.open();
  try {
    const byFrom = new Map<string, Msg[]>();
    for (const m of msgs) {
      const arr = byFrom.get(m.mailbox_name) ?? [];
      arr.push(m);
      byFrom.set(m.mailbox_name, arr);
    }
    for (const [from, group] of byFrom) {
      const to = rule.target_folder;
      await provider.createMailbox(to);
      const destId = await upsertMailboxPg(USER_ID!, { name: to, account, messageCount: 0, unreadCount: 0 });
      const ids = group.map((g) => g.id);
      console.log(`  moving ${ids.length} from "${from}" → "${to}"`);
      const results = await provider.moveMessages(ids, from, to);
      const okIds = new Set(results.filter((r) => r.ok).map((r) => r.messageId));
      await logMovesPg(USER_ID!, results.map((r) => ({
        message_id: r.messageId, from_mailbox: from, to_mailbox: to,
        account, provider: providerKind, rule_id: rule.id, batch_id: batchId,
        reason: `smoke test rule #${rule.id}`,
        status: r.ok ? "applied" as const : "failed" as const,
        error: r.error ?? null,
      })));
      for (const g of group) {
        if (okIds.has(g.id)) {
          await updateMessageMailboxPg(USER_ID!, g.id, destId);
        }
      }
      console.log(`  ${[...okIds].length}/${ids.length} ok`);
    }
    await touchRuleAppliedPg(USER_ID!, rule.id);
    await writeMemoryPg(USER_ID!, {
      kind: "apply_action", key: rule.target_folder, source: "self",
      content: `Smoke test: rule #${rule.id} moved ${msgs.length} message(s). Batch ${batchId}.`,
    });
    console.log(`\nDone. Batch ID: ${batchId}`);
    console.log(`Now open /mail-analyzer/history and click "Undo batch", or POST { batch_id: "${batchId}" } to /api/mail-analyzer/history/undo.`);
  } finally {
    await provider.close();
    await pg.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
