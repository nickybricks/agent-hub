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
  AgentMemory,
  AuditFinding,
  AuditFindingInput,
  AuditFindingKind,
  FolderRule,
  FolderRuleStatus,
  ProposalWithRules,
  ProposedFolder,
  ProposedFolderStatus,
  ReviewQueueInput,
  ReviewQueueRich,
  RuleMatchMessage,
  SenderForProposal,
  TriageCandidate,
  UnclassifiedSender,
} from "./analyzer-db";
import type { MailMessage } from "./mail-provider";

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

// ── scan: messages upsert / watermark / scan_runs ────────────────────────────

export async function upsertMessagesPg(
  userId: string,
  messages: MailMessage[],
  mailboxId: number,
): Promise<void> {
  if (messages.length === 0) return;
  const db = getDrizzleDb();
  const now = new Date().toISOString();
  const CHUNK = 500;

  for (let i = 0; i < messages.length; i += CHUNK) {
    const slice = messages.slice(i, i + CHUNK);

    // Postgres rejects ON CONFLICT DO UPDATE when a single statement touches the
    // same conflict key twice, so dedupe within the chunk (last write wins, like
    // the per-row SQLite loop). Messages key on id; senders key on lowered email.
    const byId = new Map<string, MailMessage>();
    for (const m of slice) byId.set(m.id, m);
    const dedupedMsgs = [...byId.values()];

    const msgRows = sql.join(
      dedupedMsgs.map(
        (m) =>
          sql`(${m.id}, ${mailboxId}, ${m.senderEmail}, ${m.senderName}, ${m.subject}, ${m.dateReceived}, ${m.isRead}, ${m.sizeBytes}, ${now}, ${m.headersJson ?? null}, ${userId})`,
      ),
      sql`, `,
    );
    await db.execute(sql`
      INSERT INTO messages
        (id, mailbox_id, sender_email, sender_name, subject, date_received, is_read, size_bytes, scanned_at, headers_json, user_id)
      VALUES ${msgRows}
      ON CONFLICT (id) DO UPDATE SET
        is_read = excluded.is_read,
        scanned_at = excluded.scanned_at,
        headers_json = COALESCE(excluded.headers_json, messages.headers_json)
    `);

    const byEmail = new Map<string, { email: string; domain: string; displayName: string | null }>();
    for (const m of slice) {
      const email = m.senderEmail.toLowerCase();
      const domain = m.senderEmail.includes("@")
        ? m.senderEmail.split("@")[1].toLowerCase()
        : m.senderEmail;
      const displayName = m.senderName || null;
      const existing = byEmail.get(email);
      // Prefer a non-null display name, mirroring the COALESCE upsert intent.
      if (!existing || (displayName && !existing.displayName)) {
        byEmail.set(email, { email, domain, displayName });
      }
    }

    const senderRows = sql.join(
      [...byEmail.values()].map(
        (s) => sql`(${s.email}, ${s.domain}, ${s.displayName}, ${userId})`,
      ),
      sql`, `,
    );
    await db.execute(sql`
      INSERT INTO senders (email, domain, display_name, user_id)
      VALUES ${senderRows}
      ON CONFLICT (email, user_id) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, senders.display_name)
    `);
  }
}

export async function getWatermarkPg(
  userId: string,
  mailboxName: string,
  account: string,
): Promise<string | null> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT MAX(m.date_received) AS watermark
    FROM messages m
    JOIN mailboxes mb ON m.mailbox_id = mb.id
    WHERE mb.name = ${mailboxName} AND mb.account = ${account}
      AND mb.user_id = ${userId} AND m.user_id = ${userId}
  `);
  return (rows[0] as { watermark: string | null } | undefined)?.watermark ?? null;
}

export async function startScanRunPg(userId: string): Promise<number> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    INSERT INTO scan_runs (started_at, status, user_id)
    VALUES (${new Date().toISOString()}, 'running', ${userId})
    RETURNING id
  `);
  return Number((rows[0] as { id: number }).id);
}

export async function updateScanProgressPg(
  userId: string,
  id: number,
  messagesScanned: number,
): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    UPDATE scan_runs SET messages_scanned = ${messagesScanned}
    WHERE id = ${id} AND user_id = ${userId}
  `);
}

export async function findInProgressScanPg(
  userId: string,
): Promise<{ id: number; started_at: string } | null> {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT id, started_at FROM scan_runs
    WHERE user_id = ${userId} AND status = 'running' AND started_at > ${cutoff}
    ORDER BY id DESC LIMIT 1
  `);
  const row = (rows as unknown as { id: number; started_at: string }[])[0];
  return row ? { id: Number(row.id), started_at: row.started_at } : null;
}

export async function finishScanRunPg(
  userId: string,
  id: number,
  messagesScanned: number,
  watermark: string | null,
): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    UPDATE scan_runs
    SET finished_at = ${new Date().toISOString()},
        messages_scanned = ${messagesScanned},
        watermark_date = ${watermark},
        status = 'ok'
    WHERE id = ${id} AND user_id = ${userId}
  `);
}

export async function failScanRunPg(userId: string, id: number, error: string): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    UPDATE scan_runs
    SET finished_at = ${new Date().toISOString()}, status = 'error', error = ${error}
    WHERE id = ${id} AND user_id = ${userId}
  `);
}

export interface ScanRunRowPg {
  id: number;
  started_at: string;
  finished_at: string | null;
  messages_scanned: number | null;
  watermark_date: string | null;
  status: string | null;
  error: string | null;
}

export async function getScanRunPg(userId: string, id: number): Promise<ScanRunRowPg | null> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT id, started_at, finished_at, messages_scanned, watermark_date, status, error
    FROM scan_runs WHERE id = ${id} AND user_id = ${userId}
  `);
  return ((rows as unknown as ScanRunRowPg[])[0]) ?? null;
}

export async function getLatestScanRunPg(userId: string): Promise<ScanRunRowPg | null> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT id, started_at, finished_at, messages_scanned, watermark_date, status, error
    FROM scan_runs WHERE user_id = ${userId} ORDER BY id DESC LIMIT 1
  `);
  return ((rows as unknown as ScanRunRowPg[])[0]) ?? null;
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

// ── classify-senders ─────────────────────────────────────────────────────────

export async function getUnclassifiedSendersPg(
  userId: string,
  model: string,
  minMessages = 1,
  limit?: number,
): Promise<UnclassifiedSender[]> {
  const db = getDrizzleDb();
  const selfEmail = (process.env.IMAP_USER || "").toLowerCase();
  const limitClause = limit ? sql`LIMIT ${Number(limit)}` : sql``;
  const rows = await db.execute(sql`
    SELECT s.email, s.domain, s.display_name,
           COUNT(m.id) AS message_count
    FROM senders s
    JOIN messages m ON LOWER(m.sender_email) = s.email AND m.user_id = ${userId}
    WHERE (s.category IS NULL OR s.classification_model != ${model})
      AND s.email != ${selfEmail}
      AND s.user_id = ${userId}
    GROUP BY s.email, s.domain, s.display_name
    HAVING COUNT(m.id) >= ${minMessages}
    ORDER BY message_count DESC
    ${limitClause}
  `);
  const senders = rows as unknown as Array<{
    email: string;
    domain: string;
    display_name: string | null;
    message_count: number;
  }>;

  const result: UnclassifiedSender[] = [];
  for (const r of senders) {
    const subjRows = await db.execute(sql`
      SELECT subject FROM messages
      WHERE LOWER(sender_email) = ${r.email} AND user_id = ${userId}
        AND subject IS NOT NULL AND subject != ''
      ORDER BY date_received DESC
      LIMIT 3
    `);
    result.push({
      ...r,
      message_count: Number(r.message_count),
      sample_subjects: (subjRows as unknown as { subject: string }[]).map((s) => s.subject),
    });
  }
  return result;
}

export async function setSenderCategoryPg(
  userId: string,
  email: string,
  category: string,
  model: string,
): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    UPDATE senders
    SET category = ${category}, classified_at = ${new Date().toISOString()}, classification_model = ${model}
    WHERE email = ${email.toLowerCase()} AND user_id = ${userId}
  `);
}

// ── analyzer read routes (categories / top-senders / mailboxes / junk / volume)

export async function getCategoryRollupPg(userId: string): Promise<unknown[]> {
  const db = getDrizzleDb();
  const selfEmail = (process.env.IMAP_USER || "").toLowerCase();
  const rows = await db.execute(sql`
    SELECT
      COALESCE(s.category, 'unclassified') AS category,
      COUNT(DISTINCT s.email) AS sender_count,
      COUNT(m.id) AS message_count
    FROM senders s
    LEFT JOIN messages m ON LOWER(m.sender_email) = s.email AND m.user_id = ${userId}
    WHERE s.email != ${selfEmail} AND s.user_id = ${userId}
    GROUP BY COALESCE(s.category, 'unclassified')
    ORDER BY message_count DESC
  `);
  return rows as unknown as unknown[];
}

export async function getTopSendersPg(userId: string, category: string | null): Promise<unknown[]> {
  const db = getDrizzleDb();
  const selfEmail = (process.env.IMAP_USER || "").toLowerCase();
  let categoryClause = sql``;
  if (category && category !== "all") {
    categoryClause =
      category === "unclassified"
        ? sql`AND s.category IS NULL`
        : sql`AND s.category = ${category}`;
  }
  const rows = await db.execute(sql`
    SELECT
      m.sender_email,
      m.sender_name,
      s.domain,
      s.category,
      COUNT(*) AS message_count,
      SUM(CASE WHEN m.is_read = false THEN 1 ELSE 0 END) AS unread_count,
      MAX(m.date_received) AS last_seen,
      SUM(CASE WHEN LOWER(mb.name) LIKE '%junk%' OR LOWER(mb.name) LIKE '%spam%' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) AS junk_pct
    FROM messages m
    JOIN mailboxes mb ON m.mailbox_id = mb.id
    LEFT JOIN senders s ON LOWER(m.sender_email) = s.email AND s.user_id = ${userId}
    WHERE LOWER(m.sender_email) != ${selfEmail}
      AND m.user_id = ${userId}
      ${categoryClause}
    GROUP BY m.sender_email, m.sender_name, s.domain, s.category
    ORDER BY message_count DESC
    LIMIT 50
  `);
  return rows as unknown as unknown[];
}

export async function listMailboxesPg(userId: string): Promise<unknown[]> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT
      mb.name,
      mb.account,
      mb.message_count,
      mb.unread_count,
      mb.last_scanned_at,
      COUNT(m.id) AS scanned_messages,
      SUM(m.size_bytes) AS total_size_bytes
    FROM mailboxes mb
    LEFT JOIN messages m ON m.mailbox_id = mb.id AND m.user_id = ${userId}
    WHERE mb.user_id = ${userId}
    GROUP BY mb.id
    ORDER BY scanned_messages DESC
  `);
  return rows as unknown as unknown[];
}

export async function getJunkSummaryPg(
  userId: string,
): Promise<{ topSenders: unknown[]; sampleSubjects: unknown[]; total: number }> {
  const db = getDrizzleDb();
  const topSenders = await db.execute(sql`
    SELECT
      m.sender_email,
      m.sender_name,
      COUNT(*) AS message_count,
      MAX(m.date_received) AS last_seen
    FROM messages m
    JOIN mailboxes mb ON m.mailbox_id = mb.id
    WHERE (LOWER(mb.name) LIKE '%junk%' OR LOWER(mb.name) LIKE '%spam%')
      AND m.user_id = ${userId}
    GROUP BY m.sender_email, m.sender_name
    ORDER BY message_count DESC
    LIMIT 30
  `);
  const sampleSubjects = await db.execute(sql`
    SELECT m.sender_email, m.subject, m.date_received
    FROM messages m
    JOIN mailboxes mb ON m.mailbox_id = mb.id
    WHERE (LOWER(mb.name) LIKE '%junk%' OR LOWER(mb.name) LIKE '%spam%')
      AND m.user_id = ${userId}
    ORDER BY m.date_received DESC
    LIMIT 50
  `);
  const total = await db.execute(sql`
    SELECT COUNT(*) AS count FROM messages m
    JOIN mailboxes mb ON m.mailbox_id = mb.id
    WHERE (LOWER(mb.name) LIKE '%junk%' OR LOWER(mb.name) LIKE '%spam%')
      AND m.user_id = ${userId}
  `);
  return {
    topSenders: topSenders as unknown as unknown[],
    sampleSubjects: sampleSubjects as unknown as unknown[],
    total: Number((total[0] as { count: number }).count),
  };
}

export async function getVolumeByDayPg(userId: string): Promise<unknown[]> {
  const db = getDrizzleDb();
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = await db.execute(sql`
    SELECT
      SUBSTRING(date_received FROM 1 FOR 10) AS day,
      COUNT(*) AS message_count
    FROM messages
    WHERE user_id = ${userId} AND date_received >= ${cutoff}
    GROUP BY day
    ORDER BY day ASC
  `);
  return rows as unknown as unknown[];
}

// ── audit ────────────────────────────────────────────────────────────────────

export async function clearAuditFindingsPg(
  userId: string,
  kinds?: AuditFindingKind[],
): Promise<void> {
  const db = getDrizzleDb();
  if (!kinds || kinds.length === 0) {
    await db.execute(sql`
      DELETE FROM audit_findings WHERE dismissed_at IS NULL AND user_id = ${userId}
    `);
    return;
  }
  const kindList = sql.join(kinds.map((k) => sql`${k}`), sql`, `);
  await db.execute(sql`
    DELETE FROM audit_findings
    WHERE dismissed_at IS NULL AND user_id = ${userId} AND kind IN (${kindList})
  `);
}

export async function insertAuditFindingsPg(
  userId: string,
  findings: AuditFindingInput[],
): Promise<void> {
  if (findings.length === 0) return;
  const db = getDrizzleDb();
  const now = new Date().toISOString();
  const CHUNK = 500;
  for (let i = 0; i < findings.length; i += CHUNK) {
    const slice = findings.slice(i, i + CHUNK);
    const rows = sql.join(
      slice.map(
        (f) =>
          sql`(${f.kind}, ${f.sender_email}, ${f.mailbox_id}, ${JSON.stringify(f.message_ids)}, ${f.suggested_action}, ${f.score}, ${f.reasoning}, ${now}, ${userId})`,
      ),
      sql`, `,
    );
    await db.execute(sql`
      INSERT INTO audit_findings
        (kind, sender_email, mailbox_id, message_ids_json, suggested_action, score, reasoning, created_at, user_id)
      VALUES ${rows}
    `);
  }
}

export async function listAuditFindingsPg(
  userId: string,
  kind?: AuditFindingKind,
): Promise<AuditFinding[]> {
  const db = getDrizzleDb();
  const rows = kind
    ? await db.execute(sql`
        SELECT * FROM audit_findings
        WHERE dismissed_at IS NULL AND user_id = ${userId} AND kind = ${kind}
        ORDER BY score DESC, id
      `)
    : await db.execute(sql`
        SELECT * FROM audit_findings
        WHERE dismissed_at IS NULL AND user_id = ${userId}
        ORDER BY kind, score DESC, id
      `);
  return (rows as unknown as Array<{
    id: number;
    kind: AuditFindingKind;
    sender_email: string | null;
    mailbox_id: number | null;
    message_ids_json: string;
    suggested_action: string;
    score: number;
    reasoning: string | null;
    created_at: string;
    dismissed_at: string | null;
  }>).map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    sender_email: r.sender_email,
    mailbox_id: r.mailbox_id,
    message_ids: JSON.parse(r.message_ids_json) as string[],
    suggested_action: r.suggested_action,
    score: r.score,
    reasoning: r.reasoning,
    created_at: r.created_at,
    dismissed_at: r.dismissed_at,
  }));
}

export async function dismissAuditFindingPg(userId: string, id: number): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    UPDATE audit_findings SET dismissed_at = ${new Date().toISOString()}
    WHERE id = ${id} AND user_id = ${userId}
  `);
}

export async function setMessageOverridePg(
  userId: string,
  messageId: string,
  kind: AuditFindingKind,
  decision: "include" | "exclude" | "agree",
): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    INSERT INTO audit_message_overrides (message_id, kind, decision, created_at, user_id)
    VALUES (${messageId}, ${kind}, ${decision}, ${new Date().toISOString()}, ${userId})
    ON CONFLICT (message_id, kind, user_id) DO UPDATE SET
      decision = excluded.decision, created_at = excluded.created_at
  `);
}

export async function getMessageOverridesPg(
  userId: string,
  kind: AuditFindingKind,
  messageIds: string[],
): Promise<Map<string, string>> {
  if (messageIds.length === 0) return new Map<string, string>();
  const db = getDrizzleDb();
  const idList = sql.join(messageIds.map((m) => sql`${m}`), sql`, `);
  const rows = await db.execute(sql`
    SELECT message_id, decision FROM audit_message_overrides
    WHERE user_id = ${userId} AND kind = ${kind} AND message_id IN (${idList})
  `);
  return new Map(
    (rows as unknown as { message_id: string; decision: string }[]).map((r) => [
      r.message_id,
      r.decision,
    ]),
  );
}

export interface AuditMessageDetailPg {
  id: string;
  subject: string | null;
  date_received: string;
  is_read: number;
  mailbox_name: string;
}

export async function getAuditMessageDetailsPg(
  userId: string,
  ids: string[],
): Promise<AuditMessageDetailPg[]> {
  if (ids.length === 0) return [];
  const db = getDrizzleDb();
  const idList = sql.join(ids.map((i) => sql`${i}`), sql`, `);
  const rows = await db.execute(sql`
    SELECT m.id, m.subject, m.date_received, m.is_read, mb.name AS mailbox_name
    FROM messages m
    JOIN mailboxes mb ON m.mailbox_id = mb.id
    WHERE m.user_id = ${userId} AND m.id IN (${idList})
  `);
  return (rows as unknown as Array<AuditMessageDetailPg & { is_read: boolean | number }>).map(
    (r) => ({
      ...r,
      is_read: typeof r.is_read === "boolean" ? (r.is_read ? 1 : 0) : Number(r.is_read),
    }),
  );
}

export interface AuditRunRowPg {
  id: number;
  started_at: string;
  finished_at: string | null;
  findings_count: number | null;
  status: string;
}

export async function getLastAuditRunPg(userId: string): Promise<AuditRunRowPg | null> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT id, started_at, finished_at, findings_count, status
    FROM audit_runs WHERE user_id = ${userId}
    ORDER BY id DESC LIMIT 1
  `);
  return ((rows as unknown as AuditRunRowPg[])[0]) ?? null;
}

export async function startAuditRunPg(userId: string): Promise<number> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    INSERT INTO audit_runs (started_at, status, user_id)
    VALUES (${new Date().toISOString()}, 'running', ${userId})
    RETURNING id
  `);
  return Number((rows[0] as { id: number }).id);
}

export async function finishAuditRunPg(
  userId: string,
  id: number,
  findingsCount: number,
): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    UPDATE audit_runs
    SET finished_at = ${new Date().toISOString()}, findings_count = ${findingsCount}, status = 'ok'
    WHERE id = ${id} AND user_id = ${userId}
  `);
}

export async function failAuditRunPg(userId: string, id: number, error: string): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    UPDATE audit_runs
    SET finished_at = ${new Date().toISOString()}, status = 'error', error = ${error}
    WHERE id = ${id} AND user_id = ${userId}
  `);
}

// ── proposals (propose-structure + /proposals/*) ─────────────────────────────

export async function getSendersForProposalPg(
  userId: string,
  minMessages = 5,
  limit = 250,
): Promise<SenderForProposal[]> {
  const db = getDrizzleDb();
  const selfEmail = (process.env.IMAP_USER || "").toLowerCase();
  const rows = await db.execute(sql`
    SELECT s.email, s.domain, s.display_name, s.category,
           COUNT(m.id) AS message_count,
           SUM(CASE WHEN LOWER(mb.name) LIKE '%spam%' OR LOWER(mb.name) LIKE '%junk%' THEN 1 ELSE 0 END) AS spam_count
    FROM senders s
    JOIN messages m ON LOWER(m.sender_email) = s.email AND m.user_id = ${userId}
    JOIN mailboxes mb ON m.mailbox_id = mb.id
    WHERE s.email != ${selfEmail} AND s.user_id = ${userId}
    GROUP BY s.email, s.domain, s.display_name, s.category
    HAVING COUNT(m.id) >= ${minMessages}
       AND (SUM(CASE WHEN LOWER(mb.name) LIKE '%spam%' OR LOWER(mb.name) LIKE '%junk%' THEN 1 ELSE 0 END) * 1.0 / COUNT(m.id)) < 0.5
    ORDER BY message_count DESC
    LIMIT ${limit}
  `);
  const senders = rows as unknown as Array<{
    email: string;
    domain: string;
    display_name: string | null;
    category: string | null;
    message_count: number;
  }>;
  const result: SenderForProposal[] = [];
  for (const r of senders) {
    const subj = await db.execute(sql`
      SELECT subject FROM messages
      WHERE LOWER(sender_email) = ${r.email} AND user_id = ${userId}
        AND subject IS NOT NULL AND subject != ''
      ORDER BY date_received DESC
      LIMIT 2
    `);
    result.push({
      email: r.email,
      domain: r.domain,
      display_name: r.display_name,
      category: r.category,
      message_count: Number(r.message_count),
      sample_subjects: (subj as unknown as { subject: string }[]).map((s) => s.subject),
    });
  }
  return result;
}

export async function getProposalFolderRowsPg(
  userId: string,
): Promise<{ id: number; name: string; msg_count: number }[]> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT mb.id, mb.name, COUNT(m.id) AS msg_count
    FROM mailboxes mb
    LEFT JOIN messages m ON m.mailbox_id = mb.id AND m.user_id = ${userId}
    WHERE mb.user_id = ${userId}
    GROUP BY mb.id
    ORDER BY msg_count DESC
  `);
  return (rows as unknown as { id: number; name: string; msg_count: number }[]).map((r) => ({
    id: Number(r.id),
    name: r.name,
    msg_count: Number(r.msg_count),
  }));
}

export async function getTopSendersForMailboxPg(
  userId: string,
  mailboxId: number,
): Promise<{ sender_email: string; c: number }[]> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT LOWER(sender_email) AS sender_email, COUNT(*) AS c
    FROM messages WHERE mailbox_id = ${mailboxId} AND user_id = ${userId}
    GROUP BY LOWER(sender_email)
    ORDER BY c DESC LIMIT 3
  `);
  return (rows as unknown as { sender_email: string; c: number }[]).map((r) => ({
    sender_email: r.sender_email,
    c: Number(r.c),
  }));
}

export async function getCategoryDistributionPg(
  userId: string,
): Promise<{ category: string; senders: number; msgs: number }[]> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT s.category, COUNT(DISTINCT s.email) AS senders, COUNT(m.id) AS msgs
    FROM senders s
    JOIN messages m ON LOWER(m.sender_email) = s.email AND m.user_id = ${userId}
    WHERE s.category IS NOT NULL AND s.user_id = ${userId}
    GROUP BY s.category
    ORDER BY msgs DESC
  `);
  return (rows as unknown as { category: string; senders: number; msgs: number }[]).map((r) => ({
    category: r.category,
    senders: Number(r.senders),
    msgs: Number(r.msgs),
  }));
}

export async function getMailboxTotalsPg(
  userId: string,
): Promise<{ msgs: number; senders: number }> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT COUNT(*) AS msgs, COUNT(DISTINCT sender_email) AS senders
    FROM messages WHERE user_id = ${userId}
  `);
  const r = (rows[0] as { msgs: number; senders: number }) ?? { msgs: 0, senders: 0 };
  return { msgs: Number(r.msgs), senders: Number(r.senders) };
}

export async function insertProposedFoldersPg(
  userId: string,
  items: { path: string; rationale?: string | null }[],
): Promise<void> {
  if (items.length === 0) return;
  const db = getDrizzleDb();
  const now = new Date().toISOString();
  for (const r of items) {
    await db.execute(sql`
      INSERT INTO proposed_folders (path, rationale, status, created_at, user_id)
      SELECT ${r.path}, ${r.rationale ?? null}, 'proposed', ${now}, ${userId}
      WHERE NOT EXISTS (
        SELECT 1 FROM proposed_folders WHERE path = ${r.path} AND user_id = ${userId}
      )
    `);
  }
}

export async function getProposedFolderByPathPg(
  userId: string,
  path: string,
): Promise<ProposedFolder | null> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT * FROM proposed_folders WHERE path = ${path} AND user_id = ${userId}
  `);
  return ((rows as unknown as ProposedFolder[])[0]) ?? null;
}

export async function getProposedFolderByIdPg(
  userId: string,
  id: number,
): Promise<ProposedFolder | null> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT * FROM proposed_folders WHERE id = ${id} AND user_id = ${userId}
  `);
  return ((rows as unknown as ProposedFolder[])[0]) ?? null;
}

export async function setProposedFolderStatusPg(
  userId: string,
  id: number,
  status: ProposedFolderStatus,
): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    UPDATE proposed_folders SET status = ${status}, decided_at = ${new Date().toISOString()}
    WHERE id = ${id} AND user_id = ${userId}
  `);
}

export async function updateProposedFolderPathPg(
  userId: string,
  id: number,
  path: string,
): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    UPDATE proposed_folders SET path = ${path} WHERE id = ${id} AND user_id = ${userId}
  `);
}

export async function getFolderRulePg(userId: string, id: number): Promise<FolderRule | null> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT * FROM folder_rules WHERE id = ${id} AND user_id = ${userId}
  `);
  return ((rows as unknown as FolderRule[])[0]) ?? null;
}

export async function setFolderRuleStatusPg(
  userId: string,
  id: number,
  status: FolderRuleStatus,
): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    UPDATE folder_rules SET status = ${status}, decided_at = ${new Date().toISOString()}
    WHERE id = ${id} AND user_id = ${userId}
  `);
}

export async function updateFolderRuleMatchPg(
  userId: string,
  id: number,
  matchValue: string,
  targetFolder: string | null,
): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    UPDATE folder_rules SET match_value = ${matchValue.toLowerCase()}, target_folder = ${targetFolder}
    WHERE id = ${id} AND user_id = ${userId}
  `);
}

export async function getProposalsWithRulesPg(userId: string): Promise<ProposalWithRules[]> {
  const db = getDrizzleDb();
  const folderRows = await db.execute(sql`
    SELECT * FROM proposed_folders WHERE user_id = ${userId} ORDER BY path
  `);
  const ruleRows = await db.execute(sql`
    SELECT * FROM folder_rules
    WHERE user_id = ${userId} AND source = 'llm_proposal'
    ORDER BY id
  `);
  const folders = folderRows as unknown as ProposedFolder[];
  const rules = ruleRows as unknown as FolderRule[];
  const byTarget = new Map<string, FolderRule[]>();
  for (const r of rules) {
    if (!r.target_folder) continue;
    const arr = byTarget.get(r.target_folder) ?? [];
    arr.push(r);
    byTarget.set(r.target_folder, arr);
  }
  return folders.map((folder) => ({ folder, rules: byTarget.get(folder.path) ?? [] }));
}

export async function getMessagesMatchingRulePg(
  userId: string,
  rule: FolderRule,
): Promise<RuleMatchMessage[]> {
  const db = getDrizzleDb();
  const targetName = rule.target_folder ?? "";
  const rows =
    rule.match_type === "sender_email"
      ? await db.execute(sql`
          SELECT m.id, m.subject, m.date_received, m.sender_email, m.mailbox_id, mb.name AS mailbox_name
          FROM messages m
          JOIN mailboxes mb ON m.mailbox_id = mb.id
          WHERE LOWER(m.sender_email) = ${rule.match_value}
            AND m.user_id = ${userId}
            AND mb.name != ${targetName}
            AND NOT EXISTS (
              SELECT 1 FROM move_log ml
              WHERE ml.message_id = m.id AND ml.status = 'applied' AND ml.user_id = ${userId}
            )
          ORDER BY m.date_received DESC
        `)
      : await db.execute(sql`
          SELECT m.id, m.subject, m.date_received, m.sender_email, m.mailbox_id, mb.name AS mailbox_name
          FROM messages m
          JOIN mailboxes mb ON m.mailbox_id = mb.id
          WHERE LOWER(SUBSTRING(m.sender_email FROM POSITION('@' IN m.sender_email) + 1)) = ${rule.match_value}
            AND m.user_id = ${userId}
            AND mb.name != ${targetName}
            AND NOT EXISTS (
              SELECT 1 FROM move_log ml
              WHERE ml.message_id = m.id AND ml.status = 'applied' AND ml.user_id = ${userId}
            )
          ORDER BY m.date_received DESC
        `);
  return (rows as unknown as RuleMatchMessage[]).map((r) => ({
    ...r,
    mailbox_id: Number(r.mailbox_id),
  }));
}

// ── ask (/ask route: memories + stats) ───────────────────────────────────────

export async function listMemoriesPg(
  userId: string,
  filter?: { kind?: string; key?: string; limit?: number },
): Promise<AgentMemory[]> {
  const db = getDrizzleDb();
  const limit = filter?.limit ?? 500;
  let rows;
  if (filter?.kind && filter?.key) {
    rows = await db.execute(sql`
      SELECT * FROM agent_memory
      WHERE user_id = ${userId} AND superseded_by IS NULL AND kind = ${filter.kind} AND key = ${filter.key}
      ORDER BY created_at DESC LIMIT ${limit}
    `);
  } else if (filter?.kind) {
    rows = await db.execute(sql`
      SELECT * FROM agent_memory
      WHERE user_id = ${userId} AND superseded_by IS NULL AND kind = ${filter.kind}
      ORDER BY created_at DESC LIMIT ${limit}
    `);
  } else if (filter?.key) {
    rows = await db.execute(sql`
      SELECT * FROM agent_memory
      WHERE user_id = ${userId} AND superseded_by IS NULL AND key = ${filter.key}
      ORDER BY created_at DESC LIMIT ${limit}
    `);
  } else {
    rows = await db.execute(sql`
      SELECT * FROM agent_memory
      WHERE user_id = ${userId} AND superseded_by IS NULL
      ORDER BY created_at DESC LIMIT ${limit}
    `);
  }
  return (rows as unknown as AgentMemory[]).map((m) => ({ ...m, id: Number(m.id) }));
}

export async function supersedeMemoryPg(
  userId: string,
  oldId: number,
  newId: number,
): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    UPDATE agent_memory SET superseded_by = ${newId}
    WHERE id = ${oldId} AND user_id = ${userId}
  `);
}

export async function touchMemoryUsedPg(userId: string, id: number): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    UPDATE agent_memory SET last_used_at = ${new Date().toISOString()}
    WHERE id = ${id} AND user_id = ${userId}
  `);
}

export interface AskProposalDetailPg {
  id: number;
  path: string;
  status: string;
  rationale: string | null;
  rules: { match_type: string; match_value: string; status: string; confidence: number | null }[];
}

export interface AskAuditDetailPg {
  kind: string;
  count: number;
  examples: string[];
}

export interface AskStatsPg {
  totalMessages: number;
  totalSenders: number;
  topMailboxes: { name: string; count: number }[];
  categoryBreakdown: { category: string; count: number }[];
  recentMoves: { batch_id: string; to_mailbox: string; count: number; applied_at: string }[];
  acceptedRules: number;
  rejectedRules: number;
  proposedFolders: number;
  createdFolders: number;
  auditFindingsOpen: number;
  proposals: AskProposalDetailPg[];
  auditByKind: AskAuditDetailPg[];
}

export async function gatherAskStatsPg(userId: string): Promise<AskStatsPg> {
  const db = getDrizzleDb();
  const one = async (q: ReturnType<typeof sql>): Promise<number> =>
    Number(((await db.execute(q))[0] as { c: number }).c);

  const totalMessages = await one(sql`SELECT COUNT(*) AS c FROM messages WHERE user_id = ${userId}`);
  const totalSenders = await one(sql`SELECT COUNT(*) AS c FROM senders WHERE user_id = ${userId}`);
  const topMailboxes = (await db.execute(sql`
    SELECT mb.name AS name, COUNT(*) AS count
    FROM messages m JOIN mailboxes mb ON m.mailbox_id = mb.id
    WHERE m.user_id = ${userId}
    GROUP BY mb.name ORDER BY count DESC LIMIT 10
  `) as unknown as { name: string; count: number }[]).map((r) => ({ name: r.name, count: Number(r.count) }));
  const categoryBreakdown = (await db.execute(sql`
    SELECT COALESCE(category, 'unclassified') AS category, COUNT(*) AS count
    FROM senders WHERE user_id = ${userId}
    GROUP BY category ORDER BY count DESC
  `) as unknown as { category: string; count: number }[]).map((r) => ({ category: r.category, count: Number(r.count) }));
  const recentMoves = (await db.execute(sql`
    SELECT batch_id, to_mailbox, COUNT(*) AS count, MAX(applied_at) AS applied_at
    FROM move_log WHERE user_id = ${userId} AND status = 'applied'
    GROUP BY batch_id, to_mailbox
    ORDER BY applied_at DESC LIMIT 10
  `) as unknown as { batch_id: string; to_mailbox: string; count: number; applied_at: string }[]).map((r) => ({
    ...r, count: Number(r.count),
  }));
  const acceptedRules = await one(sql`SELECT COUNT(*) AS c FROM folder_rules WHERE user_id = ${userId} AND status = 'accepted'`);
  const rejectedRules = await one(sql`SELECT COUNT(*) AS c FROM folder_rules WHERE user_id = ${userId} AND status = 'rejected'`);
  const proposedFolders = await one(sql`SELECT COUNT(*) AS c FROM proposed_folders WHERE user_id = ${userId} AND status = 'proposed'`);
  const createdFolders = await one(sql`SELECT COUNT(*) AS c FROM proposed_folders WHERE user_id = ${userId} AND status = 'created'`);
  const auditFindingsOpen = await one(sql`SELECT COUNT(*) AS c FROM audit_findings WHERE user_id = ${userId} AND dismissed_at IS NULL`);

  const folders = (await db.execute(sql`
    SELECT id, path, status, rationale FROM proposed_folders
    WHERE user_id = ${userId} ORDER BY path
  `)) as unknown as { id: number; path: string; status: string; rationale: string | null }[];
  const rules = (await db.execute(sql`
    SELECT target_folder, match_type, match_value, status, confidence
    FROM folder_rules WHERE user_id = ${userId} AND source = 'llm_proposal'
  `)) as unknown as { target_folder: string | null; match_type: string; match_value: string; status: string; confidence: number | null }[];
  const rulesByFolder = new Map<string, AskProposalDetailPg["rules"]>();
  for (const r of rules) {
    if (!r.target_folder) continue;
    const arr = rulesByFolder.get(r.target_folder) ?? [];
    arr.push({ match_type: r.match_type, match_value: r.match_value, status: r.status, confidence: r.confidence });
    rulesByFolder.set(r.target_folder, arr);
  }
  const proposals: AskProposalDetailPg[] = folders.map((f) => ({
    id: Number(f.id),
    path: f.path,
    status: f.status,
    rationale: f.rationale,
    rules: rulesByFolder.get(f.path) ?? [],
  }));

  const auditCounts = (await db.execute(sql`
    SELECT kind, COUNT(*) AS count FROM audit_findings
    WHERE user_id = ${userId} AND dismissed_at IS NULL GROUP BY kind
  `)) as unknown as { kind: string; count: number }[];
  const auditByKind: AskAuditDetailPg[] = [];
  for (const row of auditCounts) {
    const examples = (await db.execute(sql`
      SELECT sender_email, reasoning FROM audit_findings
      WHERE user_id = ${userId} AND kind = ${row.kind} AND dismissed_at IS NULL
      ORDER BY score DESC LIMIT 3
    `)) as unknown as { sender_email: string | null; reasoning: string | null }[];
    auditByKind.push({
      kind: row.kind,
      count: Number(row.count),
      examples: examples.map((e) => `${e.sender_email ?? "(no sender)"}: ${e.reasoning ?? "(no reasoning)"}`),
    });
  }

  return {
    totalMessages, totalSenders, topMailboxes, categoryBreakdown,
    recentMoves, acceptedRules, rejectedRules, proposedFolders, createdFolders, auditFindingsOpen,
    proposals, auditByKind,
  };
}
