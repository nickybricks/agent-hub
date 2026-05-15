/**
 * Postgres-backed equivalents of analyzer-db.ts helpers used by the triage daemon
 * and review-decide route when MULTI_TENANT=true. Every function takes the
 * tenant userId as its first argument and filters/writes accordingly.
 *
 * Service-role DATABASE_URL bypasses RLS — explicit user_id filters are mandatory.
 */

import { getDrizzleDb } from "./db";
import { sql } from "drizzle-orm";
import type {
  AuditFindingKind,
  FolderRule,
  ReviewQueueInput,
  ReviewQueueRich,
  TriageCandidate,
} from "./analyzer-db";

type Drizzle = ReturnType<typeof getDrizzleDb>;

// ── triage_runs ──────────────────────────────────────────────────────────────

export async function startTriageRunPg(userId: string): Promise<number> {
  const db: Drizzle = getDrizzleDb();
  const rows = await db.execute(sql`
    INSERT INTO triage_runs (started_at, status, user_id)
    VALUES (${new Date().toISOString()}, 'running', ${userId})
    RETURNING id
  `);
  return Number((rows[0] as { id: number }).id);
}

export async function finishTriageRunPg(
  userId: string,
  id: number,
  counts: { processed: number; moved: number; queued: number },
  watermark: string | null,
): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    UPDATE triage_runs
    SET finished_at = ${new Date().toISOString()},
        messages_processed = ${counts.processed},
        messages_moved = ${counts.moved},
        messages_queued = ${counts.queued},
        watermark = ${watermark},
        status = 'ok'
    WHERE id = ${id} AND user_id = ${userId}
  `);
}

export async function failTriageRunPg(userId: string, id: number, error: string): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    UPDATE triage_runs
    SET finished_at = ${new Date().toISOString()}, status = 'error', error = ${error}
    WHERE id = ${id} AND user_id = ${userId}
  `);
}

export async function getLastTriageWatermarkPg(userId: string): Promise<string | null> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT watermark FROM triage_runs
    WHERE user_id = ${userId} AND status = 'ok' AND watermark IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `);
  return (rows[0] as { watermark: string | null } | undefined)?.watermark ?? null;
}

// ── messages / senders / rules / audit ───────────────────────────────────────

export async function getMessagesForTriagePg(
  userId: string,
  sinceScannedAt: string | null,
  limit = 500,
): Promise<TriageCandidate[]> {
  const db = getDrizzleDb();
  const since = sinceScannedAt ?? "1970-01-01T00:00:00.000Z";
  const rows = await db.execute(sql`
    SELECT m.id, m.sender_email, m.sender_name, m.subject, m.date_received, m.scanned_at,
           m.mailbox_id, mb.name AS mailbox_name, mb.account, s.category
    FROM messages m
    JOIN mailboxes mb ON m.mailbox_id = mb.id
    LEFT JOIN senders s ON LOWER(m.sender_email) = s.email AND s.user_id = ${userId}
    WHERE m.user_id = ${userId}
      AND m.scanned_at > ${since}
      AND mb.name NOT LIKE 'Sent%'
      AND mb.name NOT LIKE 'Drafts%'
      AND mb.name NOT LIKE 'Outbox%'
      AND mb.name NOT LIKE 'Trash%'
      AND mb.name NOT LIKE 'Deleted%'
    ORDER BY m.scanned_at ASC
    LIMIT ${limit}
  `);
  return rows as unknown as TriageCandidate[];
}

export async function findRuleForSenderPg(userId: string, senderEmail: string): Promise<FolderRule | null> {
  const db = getDrizzleDb();
  const email = senderEmail.toLowerCase();
  const domain = email.includes("@") ? email.split("@")[1] : email;
  // Proposed + accepted both surface — daemon distinguishes by status.
  const rows = await db.execute(sql`
    SELECT * FROM folder_rules
    WHERE user_id = ${userId}
      AND (
        (match_type = 'sender_email' AND match_value = ${email})
        OR (match_type = 'sender_domain' AND match_value = ${domain})
      )
    ORDER BY CASE match_type WHEN 'sender_email' THEN 0 ELSE 1 END,
             CASE status WHEN 'accepted' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END
    LIMIT 1
  `);
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as number,
    match_type: row.match_type as FolderRule["match_type"],
    match_value: row.match_value as string,
    action: row.action as FolderRule["action"],
    target_folder: (row.target_folder as string | null) ?? null,
    status: row.status as FolderRule["status"],
    source: row.source as FolderRule["source"],
    confidence: (row.confidence as number | null) ?? null,
    created_at: row.created_at as string,
    decided_at: (row.decided_at as string | null) ?? null,
    last_applied_at: (row.last_applied_at as string | null) ?? null,
  };
}

export async function listAuditFindingSendersPg(
  userId: string,
  kind: AuditFindingKind,
): Promise<Set<string>> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT DISTINCT LOWER(sender_email) AS sender
    FROM audit_findings
    WHERE user_id = ${userId} AND kind = ${kind} AND dismissed_at IS NULL AND sender_email IS NOT NULL
  `);
  return new Set((rows as unknown as { sender: string }[]).map((r) => r.sender));
}

// ── review_queue ─────────────────────────────────────────────────────────────

export async function enqueueReviewPg(userId: string, input: ReviewQueueInput): Promise<boolean> {
  const db = getDrizzleDb();
  const result = await db.execute(sql`
    INSERT INTO review_queue
      (message_id, mailbox_id, reason, suggested_action, suggested_target, status, created_at, user_id)
    VALUES (
      ${input.message_id}, ${input.mailbox_id}, ${input.reason},
      ${input.suggested_action ?? null}, ${input.suggested_target ?? null},
      'pending', ${new Date().toISOString()}, ${userId}
    )
    ON CONFLICT (message_id, reason, user_id) DO NOTHING
    RETURNING id
  `);
  return (result as unknown[]).length > 0;
}

export async function getReviewQueueItemPg(userId: string, id: number): Promise<ReviewQueueRich | null> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT rq.id, rq.message_id, rq.mailbox_id, rq.reason,
           rq.suggested_action, rq.suggested_target,
           rq.status, rq.decided_at, rq.decided_action, rq.created_at,
           m.subject, m.sender_email, m.sender_name, m.date_received,
           mb.name AS mailbox_name, mb.account
    FROM review_queue rq
    JOIN messages m ON rq.message_id = m.id AND m.user_id = ${userId}
    LEFT JOIN mailboxes mb ON rq.mailbox_id = mb.id
    WHERE rq.id = ${id} AND rq.user_id = ${userId}
  `);
  return (rows[0] as unknown as ReviewQueueRich | undefined) ?? null;
}

export async function setReviewDecidedPg(userId: string, id: number, action: string): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    UPDATE review_queue
    SET status = 'decided', decided_at = ${new Date().toISOString()}, decided_action = ${action}
    WHERE id = ${id} AND user_id = ${userId}
  `);
}

// ── mailboxes / messages writes ──────────────────────────────────────────────

export async function upsertMailboxPg(
  userId: string,
  info: { name: string; account: string; messageCount?: number; unreadCount?: number },
): Promise<number> {
  const db = getDrizzleDb();
  const now = new Date().toISOString();
  await db.execute(sql`
    INSERT INTO mailboxes (name, account, message_count, unread_count, last_scanned_at, user_id)
    VALUES (${info.name}, ${info.account}, ${info.messageCount ?? 0}, ${info.unreadCount ?? 0}, ${now}, ${userId})
    ON CONFLICT (name, account, user_id) DO UPDATE SET last_scanned_at = excluded.last_scanned_at
  `);
  const rows = await db.execute(sql`
    SELECT id FROM mailboxes WHERE name = ${info.name} AND account = ${info.account} AND user_id = ${userId}
  `);
  return Number((rows[0] as { id: number }).id);
}

export async function updateMessageMailboxPg(
  userId: string,
  messageId: string,
  mailboxId: number,
): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    UPDATE messages SET mailbox_id = ${mailboxId}
    WHERE id = ${messageId} AND user_id = ${userId}
  `);
}

// ── folder_rules / move_log / agent_memory writes ────────────────────────────

export async function touchRuleAppliedPg(userId: string, id: number): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    UPDATE folder_rules SET last_applied_at = ${new Date().toISOString()}
    WHERE id = ${id} AND user_id = ${userId}
  `);
}

export interface MoveLogInputPg {
  message_id: string;
  from_mailbox: string;
  to_mailbox: string;
  account: string;
  provider: string;
  rule_id?: number | null;
  batch_id: string;
  reason?: string | null;
  status: "applied" | "undone" | "failed";
  error?: string | null;
}

export async function logMovesPg(userId: string, entries: MoveLogInputPg[]): Promise<void> {
  if (entries.length === 0) return;
  const db = getDrizzleDb();
  const now = new Date().toISOString();
  for (const r of entries) {
    await db.execute(sql`
      INSERT INTO move_log
        (message_id, from_mailbox, to_mailbox, account, provider, rule_id, batch_id, reason, status, applied_at, error, user_id)
      VALUES (
        ${r.message_id}, ${r.from_mailbox}, ${r.to_mailbox}, ${r.account}, ${r.provider},
        ${r.rule_id ?? null}, ${r.batch_id}, ${r.reason ?? null}, ${r.status}, ${now}, ${r.error ?? null}, ${userId}
      )
    `);
  }
}

export interface AgentMemoryInputPg {
  kind: string;
  key?: string | null;
  content: string;
  source: string;
  confidence?: number | null;
}

export async function writeMemoryPg(userId: string, input: AgentMemoryInputPg): Promise<number> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    INSERT INTO agent_memory (kind, key, content, source, confidence, created_at, user_id)
    VALUES (${input.kind}, ${input.key ?? null}, ${input.content}, ${input.source}, ${input.confidence ?? null}, ${new Date().toISOString()}, ${userId})
    RETURNING id
  `);
  return Number((rows[0] as { id: number }).id);
}

export async function insertFolderRulePg(
  userId: string,
  rule: {
    match_type: "sender_email" | "sender_domain";
    match_value: string;
    action: "route_to" | "never_spam" | "always_spam" | "leave";
    target_folder?: string | null;
    source: "llm_proposal" | "user" | "audit_finding";
    status?: "proposed" | "accepted" | "rejected";
    confidence?: number | null;
  },
): Promise<number> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    INSERT INTO folder_rules
      (match_type, match_value, action, target_folder, status, source, confidence, created_at, user_id)
    VALUES (
      ${rule.match_type}, ${rule.match_value.toLowerCase()}, ${rule.action},
      ${rule.target_folder ?? null}, ${rule.status ?? "proposed"}, ${rule.source},
      ${rule.confidence ?? null}, ${new Date().toISOString()}, ${userId}
    )
    RETURNING id
  `);
  return Number((rows[0] as { id: number }).id);
}

// ── audit / spam-rescan: full message dump ───────────────────────────────────

export interface MsgRowPg {
  id: string;
  sender_email: string;
  sender_name: string | null;
  subject: string | null;
  date_received: string;
  is_read: number;
  size_bytes: number;
  mailbox_id: number;
  mailbox_name: string;
  headers_json: string | null;
  category: string | null;
}

export async function loadAllMessagesPg(userId: string): Promise<MsgRowPg[]> {
  const db = getDrizzleDb();
  const self = (process.env.IMAP_USER || "").toLowerCase();
  const rows = await db.execute(sql`
    SELECT m.id, m.sender_email, m.sender_name, m.subject, m.date_received,
           m.is_read, m.size_bytes, m.mailbox_id, m.headers_json,
           mb.name AS mailbox_name,
           s.category AS category
    FROM messages m
    JOIN mailboxes mb ON m.mailbox_id = mb.id
    LEFT JOIN senders s ON LOWER(m.sender_email) = s.email AND s.user_id = ${userId}
    WHERE m.user_id = ${userId} AND LOWER(m.sender_email) != ${self}
  `);
  return (rows as unknown as Array<MsgRowPg & { is_read: boolean | number }>).map((r) => ({
    ...r,
    is_read: typeof r.is_read === "boolean" ? (r.is_read ? 1 : 0) : Number(r.is_read),
  }));
}

// ── move log (undo) ──────────────────────────────────────────────────────────

export interface MoveLogRow {
  id: number;
  message_id: string;
  from_mailbox: string;
  to_mailbox: string;
  account: string;
  provider: string;
  rule_id: number | null;
  batch_id: string;
  reason: string | null;
  status: "applied" | "undone" | "failed";
  applied_at: string;
  undone_at: string | null;
  error: string | null;
}

export async function listRecentMovesPg(userId: string, limit = 500): Promise<MoveLogRow[]> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT * FROM move_log
    WHERE user_id = ${userId}
    ORDER BY id DESC
    LIMIT ${limit}
  `);
  return rows as unknown as MoveLogRow[];
}

export async function getMovesByBatchPg(userId: string, batchId: string): Promise<MoveLogRow[]> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT * FROM move_log
    WHERE user_id = ${userId} AND batch_id = ${batchId}
    ORDER BY id
  `);
  return rows as unknown as MoveLogRow[];
}

export async function getMoveByIdPg(userId: string, id: number): Promise<MoveLogRow | null> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT * FROM move_log WHERE id = ${id} AND user_id = ${userId}
  `);
  return ((rows as unknown as MoveLogRow[])[0]) ?? null;
}

export async function markMovesUndonePg(userId: string, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const db = getDrizzleDb();
  const idList = sql.join(ids.map((i) => sql`${i}`), sql`, `);
  await db.execute(sql`
    UPDATE move_log SET status = 'undone', undone_at = ${new Date().toISOString()}
    WHERE user_id = ${userId} AND id IN (${idList})
  `);
}

export async function getMailboxIdByNamePg(userId: string, name: string, account: string): Promise<number | null> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT id FROM mailboxes
    WHERE name = ${name} AND account = ${account} AND user_id = ${userId}
    LIMIT 1
  `);
  const row = (rows as unknown as { id: number }[])[0];
  return row ? Number(row.id) : null;
}

export async function findMailboxNamePg(userId: string, predicate: (name: string) => boolean): Promise<string | null> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT name FROM mailboxes WHERE user_id = ${userId} ORDER BY id
  `);
  return (rows as unknown as { name: string }[]).find((r) => predicate(r.name))?.name ?? null;
}
