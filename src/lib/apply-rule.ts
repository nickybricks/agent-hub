/**
 * Shared core for previewing and applying a folder rule. Extracted from the
 * proposals/preview + proposals/apply routes so the Phase 3.5 chat agent's
 * `apply_rule` tool reuses the exact same write path.
 */

import { randomUUID } from "crypto";
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
} from "./analyzer-db-pg";
import type { FolderRule } from "./analyzer-db";
import { createMailProvider } from "./mail-provider";
import { getMailCredentials } from "./credentials";

/** Error carrying an HTTP status so routes can map it directly. */
export class ApplyError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface RulePreview {
  rule: FolderRule;
  total: number;
  groups: {
    from_mailbox: string;
    count: number;
    samples: { id: string; subject: string | null; sender_email: string | null; date_received: string | null }[];
  }[];
}

export interface ApplyResult {
  moved: number;
  failed: number;
  batch_id: string | null;
}

async function loadRule(userId: string, ruleId: number): Promise<FolderRule> {
  const rule = await getFolderRulePg(userId, ruleId);
  if (!rule) throw new ApplyError("rule not found", 404);
  return rule;
}

export async function previewRule(userId: string, ruleId: number): Promise<RulePreview> {
  const rule = await loadRule(userId, ruleId);
  const matches = await getMessagesMatchingRulePg(userId, rule);

  const byMailbox = new Map<string, typeof matches>();
  for (const m of matches) {
    const arr = byMailbox.get(m.mailbox_name) ?? [];
    arr.push(m);
    byMailbox.set(m.mailbox_name, arr);
  }
  const groups = [...byMailbox.entries()].map(([mailbox, msgs]) => ({
    from_mailbox: mailbox,
    count: msgs.length,
    samples: msgs.slice(0, 5).map((m) => ({
      id: m.id,
      subject: m.subject,
      sender_email: m.sender_email,
      date_received: m.date_received,
    })),
  }));

  return { rule, total: matches.length, groups };
}

export async function applyRule(
  userId: string,
  ruleId: number,
  makeRule = true,
): Promise<ApplyResult> {
  const rule = await loadRule(userId, ruleId);
  if (!rule.target_folder) throw new ApplyError("rule has no target_folder", 400);

  const matches = await getMessagesMatchingRulePg(userId, rule);

  if (matches.length === 0) {
    await setFolderRuleStatusPg(userId, rule.id, makeRule ? "accepted" : "rejected");
    return { moved: 0, failed: 0, batch_id: null };
  }

  const cfg = await getMailCredentials(userId);
  const provider = await createMailProvider(userId);
  await provider.open();

  const batchId = randomUUID();
  const account = cfg.imap?.user ?? process.env.IMAP_USER ?? "default";
  const providerKind = cfg.provider ?? "imap";

  let moved = 0;
  let failed = 0;

  try {
    await provider.createMailbox(rule.target_folder);
    const destMailboxId = await upsertMailboxPg(userId, {
      name: rule.target_folder,
      account,
      messageCount: 0,
      unreadCount: 0,
    });

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

      const entries = results.map((r) => ({
        message_id: r.messageId,
        from_mailbox: fromMailbox,
        to_mailbox: rule.target_folder!,
        account,
        provider: providerKind,
        rule_id: rule.id,
        batch_id: batchId,
        reason: `proposal rule #${rule.id}: ${rule.match_type}=${rule.match_value}`,
        status: (r.ok ? "applied" : "failed") as "applied" | "failed",
        error: r.error ?? null,
      }));
      await logMovesPg(userId, entries);

      for (const m of msgs) {
        if (okIds.has(m.id)) {
          await updateMessageMailboxPg(userId, m.id, destMailboxId);
          moved++;
        } else {
          failed++;
        }
      }
    }

    await setFolderRuleStatusPg(userId, rule.id, makeRule ? "accepted" : "rejected");
    await touchRuleAppliedPg(userId, rule.id);

    const folder = await getProposedFolderByPathPg(userId, rule.target_folder);
    if (folder && folder.status !== "created") {
      await setProposedFolderStatusPg(userId, folder.id, "created");
    }
  } finally {
    await provider.close();
  }

  await writeMemoryPg(userId, {
    kind: "apply_action",
    key: rule.target_folder,
    source: "user_decision",
    content: `User applied rule #${rule.id} (${rule.match_type}=${rule.match_value} → ${rule.target_folder}): ${moved} moved, ${failed} failed. Persistent rule: ${makeRule ? "yes" : "no (one-off backfill)"}. Batch ${batchId}.`,
  });

  return { moved, failed, batch_id: batchId };
}
