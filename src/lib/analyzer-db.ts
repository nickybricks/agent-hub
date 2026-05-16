import Database from "better-sqlite3";
import { join } from "path";
import { MailboxInfo, MailMessage } from "./mail-provider";

const DB_PATH = join(process.cwd(), "data", "mail-analyzer.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  initSchema(_db);
  return _db;
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mailboxes (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      account TEXT NOT NULL,
      message_count INTEGER,
      unread_count INTEGER,
      last_scanned_at TEXT,
      UNIQUE(name, account)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      mailbox_id INTEGER REFERENCES mailboxes(id),
      sender_email TEXT NOT NULL,
      sender_name TEXT,
      subject TEXT,
      date_received TEXT NOT NULL,
      is_read INTEGER NOT NULL,
      size_bytes INTEGER,
      scanned_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_email);
    CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date_received);
    CREATE INDEX IF NOT EXISTS idx_messages_mailbox ON messages(mailbox_id);

    CREATE TABLE IF NOT EXISTS senders (
      email TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      display_name TEXT,
      category TEXT,
      classified_at TEXT,
      classification_model TEXT
    );

    CREATE TABLE IF NOT EXISTS scan_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      messages_scanned INTEGER,
      watermark_date TEXT,
      status TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      sender_email TEXT,
      mailbox_id INTEGER REFERENCES mailboxes(id),
      message_ids_json TEXT NOT NULL,
      suggested_action TEXT NOT NULL,
      score REAL NOT NULL,
      reasoning TEXT,
      created_at TEXT NOT NULL,
      dismissed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_findings_kind ON audit_findings(kind);
    CREATE INDEX IF NOT EXISTS idx_findings_sender ON audit_findings(sender_email);

    CREATE TABLE IF NOT EXISTS audit_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      findings_count INTEGER,
      status TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_message_overrides (
      message_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      decision TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (message_id, kind)
    );

    CREATE TABLE IF NOT EXISTS proposed_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      rationale TEXT,
      status TEXT NOT NULL DEFAULT 'proposed',
      created_at TEXT NOT NULL,
      decided_at TEXT
    );

    CREATE TABLE IF NOT EXISTS folder_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_type TEXT NOT NULL,
      match_value TEXT NOT NULL,
      action TEXT NOT NULL,
      target_folder TEXT,
      status TEXT NOT NULL DEFAULT 'proposed',
      source TEXT NOT NULL,
      confidence REAL,
      created_at TEXT NOT NULL,
      decided_at TEXT,
      last_applied_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_rules_match ON folder_rules(match_type, match_value);
    CREATE INDEX IF NOT EXISTS idx_rules_status ON folder_rules(status);

    CREATE TABLE IF NOT EXISTS move_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      from_mailbox TEXT NOT NULL,
      to_mailbox TEXT NOT NULL,
      account TEXT NOT NULL,
      provider TEXT NOT NULL,
      rule_id INTEGER REFERENCES folder_rules(id),
      batch_id TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      undone_at TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_movelog_batch ON move_log(batch_id);
    CREATE INDEX IF NOT EXISTS idx_movelog_message ON move_log(message_id);
    CREATE INDEX IF NOT EXISTS idx_movelog_status ON move_log(status);

    CREATE TABLE IF NOT EXISTS triage_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      messages_processed INTEGER,
      messages_moved INTEGER,
      messages_queued INTEGER,
      watermark TEXT,
      status TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS review_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      mailbox_id INTEGER REFERENCES mailboxes(id),
      reason TEXT NOT NULL,
      suggested_action TEXT,
      suggested_target TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      decided_at TEXT,
      decided_action TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(message_id, reason)
    );
    CREATE INDEX IF NOT EXISTS idx_review_status ON review_queue(status);
    CREATE INDEX IF NOT EXISTS idx_review_reason ON review_queue(reason);

    CREATE TABLE IF NOT EXISTS agent_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      key TEXT,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      confidence REAL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      superseded_by INTEGER REFERENCES agent_memory(id)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_kind_key ON agent_memory(kind, key);
    CREATE INDEX IF NOT EXISTS idx_memory_active ON agent_memory(superseded_by);

    CREATE TABLE IF NOT EXISTS chat_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL REFERENCES chat_threads(id),
      role TEXT NOT NULL,
      content TEXT,
      tool_call_ref INTEGER,
      tool_name TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, id);

    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL REFERENCES chat_threads(id),
      tool_name TEXT NOT NULL,
      tool_input TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      preview TEXT,
      result TEXT,
      reasoning TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tool_calls_thread ON tool_calls(thread_id, id);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_status ON tool_calls(status);
  `);

  if (!columnExists(db, "messages", "headers_json")) {
    db.exec("ALTER TABLE messages ADD COLUMN headers_json TEXT");
  }
}

export function upsertMailbox(info: MailboxInfo): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO mailboxes (name, account, message_count, unread_count, last_scanned_at)
    VALUES (@name, @account, @messageCount, @unreadCount, @now)
    ON CONFLICT(name, account) DO UPDATE SET
      message_count = excluded.message_count,
      unread_count = excluded.unread_count,
      last_scanned_at = excluded.last_scanned_at
  `).run({ ...info, now: new Date().toISOString() });

  const row = db.prepare("SELECT id FROM mailboxes WHERE name = ? AND account = ?")
    .get(info.name, info.account) as { id: number };
  return row.id;
}

export function upsertMessages(messages: MailMessage[], mailboxId: number) {
  const db = getDb();
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO messages (id, mailbox_id, sender_email, sender_name, subject, date_received, is_read, size_bytes, scanned_at, headers_json)
    VALUES (@id, @mailboxId, @senderEmail, @senderName, @subject, @dateReceived, @isRead, @sizeBytes, @scannedAt, @headersJson)
    ON CONFLICT(id) DO UPDATE SET
      is_read = excluded.is_read,
      scanned_at = excluded.scanned_at,
      headers_json = COALESCE(excluded.headers_json, messages.headers_json)
  `);

  const upsertSender = db.prepare(`
    INSERT INTO senders (email, domain, display_name)
    VALUES (@email, @domain, @displayName)
    ON CONFLICT(email) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, senders.display_name)
  `);

  const insertMany = db.transaction((msgs: MailMessage[]) => {
    for (const msg of msgs) {
      insert.run({
        id: msg.id,
        mailboxId,
        senderEmail: msg.senderEmail,
        senderName: msg.senderName,
        subject: msg.subject,
        dateReceived: msg.dateReceived,
        isRead: msg.isRead ? 1 : 0,
        sizeBytes: msg.sizeBytes,
        scannedAt: now,
        headersJson: msg.headersJson ?? null,
      });

      const domain = msg.senderEmail.includes("@")
        ? msg.senderEmail.split("@")[1].toLowerCase()
        : msg.senderEmail;
      upsertSender.run({
        email: msg.senderEmail.toLowerCase(),
        domain,
        displayName: msg.senderName || null,
      });
    }
  });

  insertMany(messages);
}

export function getWatermark(mailboxName: string, account: string): string | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT MAX(m.date_received) as watermark
    FROM messages m
    JOIN mailboxes mb ON m.mailbox_id = mb.id
    WHERE mb.name = ? AND mb.account = ?
  `).get(mailboxName, account) as { watermark: string | null };
  return row?.watermark ?? null;
}

export function startScanRun(): number {
  const db = getDb();
  const result = db.prepare(
    "INSERT INTO scan_runs (started_at, status) VALUES (?, 'running')"
  ).run(new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function updateScanProgress(id: number, messagesScanned: number) {
  getDb().prepare(
    "UPDATE scan_runs SET messages_scanned = ? WHERE id = ?"
  ).run(messagesScanned, id);
}

export function findInProgressScan(): { id: number; started_at: string } | null {
  // Treat running rows older than 30 min as abandoned (process crashed).
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const row = getDb().prepare(
    "SELECT id, started_at FROM scan_runs WHERE status = 'running' AND started_at > ? ORDER BY id DESC LIMIT 1"
  ).get(cutoff) as { id: number; started_at: string } | undefined;
  return row ?? null;
}

export function finishScanRun(id: number, messagesScanned: number, watermark: string | null) {
  getDb().prepare(`
    UPDATE scan_runs SET finished_at = ?, messages_scanned = ?, watermark_date = ?, status = 'ok'
    WHERE id = ?
  `).run(new Date().toISOString(), messagesScanned, watermark, id);
}

export const SENDER_CATEGORIES = [
  "newsletter",
  "transactional",
  "personal",
  "promotional",
  "notification",
  "social",
  "work",
  "other",
] as const;

export type SenderCategory = (typeof SENDER_CATEGORIES)[number];

export interface UnclassifiedSender {
  email: string;
  domain: string;
  display_name: string | null;
  message_count: number;
  sample_subjects: string[];
}

export function getUnclassifiedSenders(
  model: string,
  minMessages = 1,
  limit?: number,
): UnclassifiedSender[] {
  const db = getDb();
  const selfEmail = (process.env.IMAP_USER || "").toLowerCase();
  const rows = db.prepare(`
    SELECT s.email, s.domain, s.display_name,
           COUNT(m.id) as message_count
    FROM senders s
    JOIN messages m ON LOWER(m.sender_email) = s.email
    WHERE (s.category IS NULL OR s.classification_model != ?)
      AND s.email != ?
    GROUP BY s.email
    HAVING message_count >= ?
    ORDER BY message_count DESC
    ${limit ? "LIMIT " + Number(limit) : ""}
  `).all(model, selfEmail, minMessages) as Array<{
    email: string;
    domain: string;
    display_name: string | null;
    message_count: number;
  }>;

  const subjectStmt = db.prepare(`
    SELECT subject FROM messages
    WHERE LOWER(sender_email) = ? AND subject IS NOT NULL AND subject != ''
    ORDER BY date_received DESC
    LIMIT 3
  `);

  return rows.map((r) => ({
    ...r,
    sample_subjects: (subjectStmt.all(r.email) as { subject: string }[]).map((s) => s.subject),
  }));
}

export function setSenderCategory(email: string, category: string, model: string) {
  getDb().prepare(`
    UPDATE senders
    SET category = ?, classified_at = ?, classification_model = ?
    WHERE email = ?
  `).run(category, new Date().toISOString(), model, email.toLowerCase());
}

export type AuditFindingKind =
  | "false_positive_spam"
  | "false_negative_inbox"
  | "phishing_risk"
  | "hygiene_stale_sender"
  | "hygiene_storage_hog";

export interface AuditFinding {
  id: number;
  kind: AuditFindingKind;
  sender_email: string | null;
  mailbox_id: number | null;
  message_ids: string[];
  suggested_action: string;
  score: number;
  reasoning: string | null;
  created_at: string;
  dismissed_at: string | null;
}

export interface AuditFindingInput {
  kind: AuditFindingKind;
  sender_email: string | null;
  mailbox_id: number | null;
  message_ids: string[];
  suggested_action: string;
  score: number;
  reasoning: string | null;
}

export function clearAuditFindings(kinds?: AuditFindingKind[]) {
  const db = getDb();
  if (!kinds || kinds.length === 0) {
    db.prepare("DELETE FROM audit_findings WHERE dismissed_at IS NULL").run();
    return;
  }
  const placeholders = kinds.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM audit_findings WHERE dismissed_at IS NULL AND kind IN (${placeholders})`
  ).run(...kinds);
}

export function insertAuditFindings(findings: AuditFindingInput[]) {
  if (findings.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO audit_findings
      (kind, sender_email, mailbox_id, message_ids_json, suggested_action, score, reasoning, created_at)
    VALUES (@kind, @sender, @mailboxId, @ids, @action, @score, @reasoning, @createdAt)
  `);
  const insertMany = db.transaction((items: AuditFindingInput[]) => {
    for (const f of items) {
      stmt.run({
        kind: f.kind,
        sender: f.sender_email,
        mailboxId: f.mailbox_id,
        ids: JSON.stringify(f.message_ids),
        action: f.suggested_action,
        score: f.score,
        reasoning: f.reasoning,
        createdAt: now,
      });
    }
  });
  insertMany(findings);
}

export function listAuditFindings(kind?: AuditFindingKind): AuditFinding[] {
  const db = getDb();
  const rows = (kind
    ? db.prepare(
        `SELECT * FROM audit_findings WHERE dismissed_at IS NULL AND kind = ? ORDER BY score DESC, id`
      ).all(kind)
    : db.prepare(
        `SELECT * FROM audit_findings WHERE dismissed_at IS NULL ORDER BY kind, score DESC, id`
      ).all()) as Array<{
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
      }>;
  return rows.map((r) => ({
    id: r.id,
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

export function dismissAuditFinding(id: number) {
  getDb().prepare(
    `UPDATE audit_findings SET dismissed_at = ? WHERE id = ?`
  ).run(new Date().toISOString(), id);
}

export function setMessageOverride(
  messageId: string,
  kind: AuditFindingKind,
  decision: "include" | "exclude" | "agree",
) {
  getDb().prepare(
    `INSERT INTO audit_message_overrides (message_id, kind, decision, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(message_id, kind) DO UPDATE SET decision = excluded.decision, created_at = excluded.created_at`
  ).run(messageId, kind, decision, new Date().toISOString());
}

export function getMessageOverrides(kind: AuditFindingKind, messageIds: string[]) {
  if (messageIds.length === 0) return new Map<string, string>();
  const db = getDb();
  const placeholders = messageIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT message_id, decision FROM audit_message_overrides WHERE kind = ? AND message_id IN (${placeholders})`
  ).all(kind, ...messageIds) as { message_id: string; decision: string }[];
  return new Map(rows.map((r) => [r.message_id, r.decision]));
}

export function startAuditRun(): number {
  const result = getDb().prepare(
    `INSERT INTO audit_runs (started_at, status) VALUES (?, 'running')`
  ).run(new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function finishAuditRun(id: number, findingsCount: number) {
  getDb().prepare(
    `UPDATE audit_runs SET finished_at = ?, findings_count = ?, status = 'ok' WHERE id = ?`
  ).run(new Date().toISOString(), findingsCount, id);
}

export function failAuditRun(id: number, error: string) {
  getDb().prepare(
    `UPDATE audit_runs SET finished_at = ?, status = 'error', error = ? WHERE id = ?`
  ).run(new Date().toISOString(), error, id);
}

export function failScanRun(id: number, error: string) {
  getDb().prepare(`
    UPDATE scan_runs SET finished_at = ?, status = 'error', error = ? WHERE id = ?
  `).run(new Date().toISOString(), error, id);
}

export type ProposedFolderStatus = "proposed" | "accepted" | "rejected" | "created";

export interface ProposedFolder {
  id: number;
  path: string;
  rationale: string | null;
  status: ProposedFolderStatus;
  created_at: string;
  decided_at: string | null;
}

export function insertProposedFolders(items: { path: string; rationale?: string | null }[]) {
  if (items.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO proposed_folders (path, rationale, status, created_at)
    VALUES (?, ?, 'proposed', ?)
    ON CONFLICT(path) DO NOTHING
  `);
  const tx = db.transaction((rows: { path: string; rationale?: string | null }[]) => {
    for (const r of rows) stmt.run(r.path, r.rationale ?? null, now);
  });
  tx(items);
}

export function listProposedFolders(status?: ProposedFolderStatus): ProposedFolder[] {
  const db = getDb();
  return (status
    ? db.prepare(`SELECT * FROM proposed_folders WHERE status = ? ORDER BY path`).all(status)
    : db.prepare(`SELECT * FROM proposed_folders ORDER BY path`).all()) as ProposedFolder[];
}

export function setProposedFolderStatus(id: number, status: ProposedFolderStatus) {
  getDb().prepare(
    `UPDATE proposed_folders SET status = ?, decided_at = ? WHERE id = ?`
  ).run(status, new Date().toISOString(), id);
}

export type FolderRuleMatchType = "sender_email" | "sender_domain";
export type FolderRuleAction = "route_to" | "never_spam" | "always_spam" | "leave";
export type FolderRuleStatus = "proposed" | "accepted" | "rejected";
export type FolderRuleSource = "llm_proposal" | "user" | "audit_finding";

export interface FolderRule {
  id: number;
  match_type: FolderRuleMatchType;
  match_value: string;
  action: FolderRuleAction;
  target_folder: string | null;
  status: FolderRuleStatus;
  source: FolderRuleSource;
  confidence: number | null;
  created_at: string;
  decided_at: string | null;
  last_applied_at: string | null;
}

export interface FolderRuleInput {
  match_type: FolderRuleMatchType;
  match_value: string;
  action: FolderRuleAction;
  target_folder?: string | null;
  source: FolderRuleSource;
  confidence?: number | null;
  status?: FolderRuleStatus;
}

export function insertFolderRule(rule: FolderRuleInput): number {
  const result = getDb().prepare(`
    INSERT INTO folder_rules
      (match_type, match_value, action, target_folder, status, source, confidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rule.match_type,
    rule.match_value.toLowerCase(),
    rule.action,
    rule.target_folder ?? null,
    rule.status ?? "proposed",
    rule.source,
    rule.confidence ?? null,
    new Date().toISOString()
  );
  return Number(result.lastInsertRowid);
}

export function listFolderRules(status?: FolderRuleStatus): FolderRule[] {
  const db = getDb();
  return (status
    ? db.prepare(`SELECT * FROM folder_rules WHERE status = ? ORDER BY id DESC`).all(status)
    : db.prepare(`SELECT * FROM folder_rules ORDER BY id DESC`).all()) as FolderRule[];
}

export function setFolderRuleStatus(id: number, status: FolderRuleStatus) {
  getDb().prepare(
    `UPDATE folder_rules SET status = ?, decided_at = ? WHERE id = ?`
  ).run(status, new Date().toISOString(), id);
}

export function findRuleForSender(senderEmail: string): FolderRule | null {
  const db = getDb();
  const email = senderEmail.toLowerCase();
  const domain = email.includes("@") ? email.split("@")[1] : email;
  const row = db.prepare(`
    SELECT * FROM folder_rules
    WHERE status = 'accepted'
      AND (
        (match_type = 'sender_email' AND match_value = ?)
        OR (match_type = 'sender_domain' AND match_value = ?)
      )
    ORDER BY CASE match_type WHEN 'sender_email' THEN 0 ELSE 1 END
    LIMIT 1
  `).get(email, domain) as FolderRule | undefined;
  return row ?? null;
}

export function touchRuleApplied(id: number) {
  getDb().prepare(`UPDATE folder_rules SET last_applied_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

export type MoveStatus = "applied" | "undone" | "failed";

export interface MoveLogEntry {
  id: number;
  message_id: string;
  from_mailbox: string;
  to_mailbox: string;
  account: string;
  provider: string;
  rule_id: number | null;
  batch_id: string;
  reason: string | null;
  status: MoveStatus;
  applied_at: string;
  undone_at: string | null;
  error: string | null;
}

export interface MoveLogInput {
  message_id: string;
  from_mailbox: string;
  to_mailbox: string;
  account: string;
  provider: string;
  rule_id?: number | null;
  batch_id: string;
  reason?: string | null;
  status: MoveStatus;
  error?: string | null;
}

export function logMoves(entries: MoveLogInput[]) {
  if (entries.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO move_log
      (message_id, from_mailbox, to_mailbox, account, provider, rule_id, batch_id, reason, status, applied_at, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((rows: MoveLogInput[]) => {
    for (const r of rows) {
      stmt.run(
        r.message_id,
        r.from_mailbox,
        r.to_mailbox,
        r.account,
        r.provider,
        r.rule_id ?? null,
        r.batch_id,
        r.reason ?? null,
        r.status,
        now,
        r.error ?? null
      );
    }
  });
  tx(entries);
}

export function getMovesByBatch(batchId: string): MoveLogEntry[] {
  return getDb().prepare(
    `SELECT * FROM move_log WHERE batch_id = ? ORDER BY id`
  ).all(batchId) as MoveLogEntry[];
}

export function listRecentMoves(limit = 100): MoveLogEntry[] {
  return getDb().prepare(
    `SELECT * FROM move_log ORDER BY id DESC LIMIT ?`
  ).all(limit) as MoveLogEntry[];
}

export interface SenderForProposal {
  email: string;
  domain: string;
  display_name: string | null;
  category: string | null;
  message_count: number;
  sample_subjects: string[];
}

export function getSendersForProposal(minMessages = 5, limit = 250): SenderForProposal[] {
  const db = getDb();
  const selfEmail = (process.env.IMAP_USER || "").toLowerCase();
  // Exclude senders whose mail mostly lives in Spam/Junk — they shouldn't get routing rules.
  // The audit page handles spam-recovery for false positives separately.
  const rows = db.prepare(`
    SELECT s.email, s.domain, s.display_name, s.category,
           COUNT(m.id) AS message_count,
           SUM(CASE WHEN LOWER(mb.name) LIKE '%spam%' OR LOWER(mb.name) LIKE '%junk%' THEN 1 ELSE 0 END) AS spam_count
    FROM senders s
    JOIN messages m ON LOWER(m.sender_email) = s.email
    JOIN mailboxes mb ON m.mailbox_id = mb.id
    WHERE s.email != ?
    GROUP BY s.email
    HAVING message_count >= ?
       AND (spam_count * 1.0 / message_count) < 0.5
    ORDER BY message_count DESC
    LIMIT ?
  `).all(selfEmail, minMessages, limit) as Array<{
    email: string;
    domain: string;
    display_name: string | null;
    category: string | null;
    message_count: number;
    spam_count: number;
  }>;

  const subjectStmt = db.prepare(`
    SELECT subject FROM messages
    WHERE LOWER(sender_email) = ? AND subject IS NOT NULL AND subject != ''
    ORDER BY date_received DESC
    LIMIT 2
  `);
  return rows.map((r) => ({
    email: r.email,
    domain: r.domain,
    display_name: r.display_name,
    category: r.category,
    message_count: r.message_count,
    sample_subjects: (subjectStmt.all(r.email) as { subject: string }[]).map((s) => s.subject),
  }));
}

export interface ProposalWithRules {
  folder: ProposedFolder;
  rules: FolderRule[];
}

export function getProposalsWithRules(): ProposalWithRules[] {
  const db = getDb();
  const folders = db.prepare(`SELECT * FROM proposed_folders ORDER BY path`).all() as ProposedFolder[];
  const rules = db.prepare(`SELECT * FROM folder_rules WHERE source = 'llm_proposal' ORDER BY id`).all() as FolderRule[];
  const byTarget = new Map<string, FolderRule[]>();
  for (const r of rules) {
    if (!r.target_folder) continue;
    const arr = byTarget.get(r.target_folder) ?? [];
    arr.push(r);
    byTarget.set(r.target_folder, arr);
  }
  return folders.map((folder) => ({ folder, rules: byTarget.get(folder.path) ?? [] }));
}

export function getFolderRule(id: number): FolderRule | null {
  const row = getDb().prepare(`SELECT * FROM folder_rules WHERE id = ?`).get(id) as FolderRule | undefined;
  return row ?? null;
}

export function getProposedFolderByPath(path: string): ProposedFolder | null {
  const row = getDb().prepare(`SELECT * FROM proposed_folders WHERE path = ?`).get(path) as ProposedFolder | undefined;
  return row ?? null;
}

export function updateFolderRuleMatch(id: number, match_value: string, target_folder: string | null) {
  getDb().prepare(
    `UPDATE folder_rules SET match_value = ?, target_folder = ? WHERE id = ?`
  ).run(match_value.toLowerCase(), target_folder, id);
}

export function updateProposedFolderPath(id: number, path: string) {
  getDb().prepare(`UPDATE proposed_folders SET path = ? WHERE id = ?`).run(path, id);
}

export interface RuleMatchMessage {
  id: string;
  subject: string | null;
  date_received: string;
  sender_email: string;
  mailbox_id: number;
  mailbox_name: string;
}

export function getMessagesMatchingRule(rule: FolderRule): RuleMatchMessage[] {
  const db = getDb();
  const targetName = rule.target_folder ?? "";
  // Exclude messages already in the target folder and any messages that have been moved (logged).
  if (rule.match_type === "sender_email") {
    return db.prepare(`
      SELECT m.id, m.subject, m.date_received, m.sender_email, m.mailbox_id, mb.name AS mailbox_name
      FROM messages m
      JOIN mailboxes mb ON m.mailbox_id = mb.id
      WHERE LOWER(m.sender_email) = ?
        AND mb.name != ?
        AND NOT EXISTS (SELECT 1 FROM move_log ml WHERE ml.message_id = m.id AND ml.status = 'applied')
      ORDER BY m.date_received DESC
    `).all(rule.match_value, targetName) as RuleMatchMessage[];
  }
  return db.prepare(`
    SELECT m.id, m.subject, m.date_received, m.sender_email, m.mailbox_id, mb.name AS mailbox_name
    FROM messages m
    JOIN mailboxes mb ON m.mailbox_id = mb.id
    WHERE LOWER(SUBSTR(m.sender_email, INSTR(m.sender_email, '@') + 1)) = ?
      AND mb.name != ?
      AND NOT EXISTS (SELECT 1 FROM move_log ml WHERE ml.message_id = m.id AND ml.status = 'applied')
    ORDER BY m.date_received DESC
  `).all(rule.match_value, targetName) as RuleMatchMessage[];
}

export function updateMessageMailbox(messageId: string, mailboxId: number) {
  getDb().prepare(`UPDATE messages SET mailbox_id = ? WHERE id = ?`).run(mailboxId, messageId);
}

export type MemoryKind =
  | "user_pref"
  | "sender_fact"
  | "rule_rationale"
  | "proposal_run"
  | "apply_action"
  | "audit_decision"
  | "mistake";

export type MemorySource = "user_decision" | "llm" | "judge" | "self";

export interface AgentMemory {
  id: number;
  kind: MemoryKind;
  key: string | null;
  content: string;
  source: MemorySource;
  confidence: number | null;
  created_at: string;
  last_used_at: string | null;
  superseded_by: number | null;
}

export interface AgentMemoryInput {
  kind: MemoryKind;
  key?: string | null;
  content: string;
  source: MemorySource;
  confidence?: number | null;
}

export function writeMemory(input: AgentMemoryInput): number {
  const info = getDb().prepare(`
    INSERT INTO agent_memory (kind, key, content, source, confidence, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    input.kind,
    input.key ?? null,
    input.content,
    input.source,
    input.confidence ?? null,
    new Date().toISOString(),
  );
  return info.lastInsertRowid as number;
}

export function touchMemoryUsed(id: number) {
  getDb().prepare(`UPDATE agent_memory SET last_used_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

export function listMemories(filter?: { kind?: MemoryKind; key?: string; limit?: number }): AgentMemory[] {
  const db = getDb();
  const limit = filter?.limit ?? 500;
  if (filter?.kind && filter?.key) {
    return db.prepare(
      `SELECT * FROM agent_memory WHERE superseded_by IS NULL AND kind = ? AND key = ? ORDER BY created_at DESC LIMIT ?`
    ).all(filter.kind, filter.key, limit) as AgentMemory[];
  }
  if (filter?.kind) {
    return db.prepare(
      `SELECT * FROM agent_memory WHERE superseded_by IS NULL AND kind = ? ORDER BY created_at DESC LIMIT ?`
    ).all(filter.kind, limit) as AgentMemory[];
  }
  if (filter?.key) {
    return db.prepare(
      `SELECT * FROM agent_memory WHERE superseded_by IS NULL AND key = ? ORDER BY created_at DESC LIMIT ?`
    ).all(filter.key, limit) as AgentMemory[];
  }
  return db.prepare(
    `SELECT * FROM agent_memory WHERE superseded_by IS NULL ORDER BY created_at DESC LIMIT ?`
  ).all(limit) as AgentMemory[];
}

export function supersedeMemory(oldId: number, newId: number) {
  getDb().prepare(`UPDATE agent_memory SET superseded_by = ? WHERE id = ?`).run(newId, oldId);
}

export function getMemoryById(id: number): AgentMemory | null {
  const row = getDb().prepare(`SELECT * FROM agent_memory WHERE id = ?`).get(id) as AgentMemory | undefined;
  return row ?? null;
}

export type TriageRunStatus = "running" | "ok" | "error";

export interface TriageRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  messages_processed: number | null;
  messages_moved: number | null;
  messages_queued: number | null;
  watermark: string | null;
  status: TriageRunStatus;
  error: string | null;
}

export function startTriageRun(): number {
  const result = getDb().prepare(
    `INSERT INTO triage_runs (started_at, status) VALUES (?, 'running')`
  ).run(new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function finishTriageRun(
  id: number,
  counts: { processed: number; moved: number; queued: number },
  watermark: string | null,
) {
  getDb().prepare(`
    UPDATE triage_runs
    SET finished_at = ?, messages_processed = ?, messages_moved = ?, messages_queued = ?, watermark = ?, status = 'ok'
    WHERE id = ?
  `).run(
    new Date().toISOString(),
    counts.processed,
    counts.moved,
    counts.queued,
    watermark,
    id,
  );
}

export function failTriageRun(id: number, error: string) {
  getDb().prepare(
    `UPDATE triage_runs SET finished_at = ?, status = 'error', error = ? WHERE id = ?`
  ).run(new Date().toISOString(), error, id);
}

export function getLastTriageWatermark(): string | null {
  const row = getDb().prepare(
    `SELECT watermark FROM triage_runs WHERE status = 'ok' AND watermark IS NOT NULL ORDER BY id DESC LIMIT 1`
  ).get() as { watermark: string | null } | undefined;
  return row?.watermark ?? null;
}

export function listTriageRuns(limit = 20): TriageRun[] {
  return getDb().prepare(
    `SELECT * FROM triage_runs ORDER BY id DESC LIMIT ?`
  ).all(limit) as TriageRun[];
}

export interface TriageCandidate {
  id: string;
  sender_email: string;
  sender_name: string | null;
  subject: string | null;
  date_received: string;
  scanned_at: string;
  mailbox_id: number;
  mailbox_name: string;
  account: string;
  category: string | null;
}

export function getMessagesForTriage(sinceScannedAt: string | null, limit = 500): TriageCandidate[] {
  const db = getDb();
  const since = sinceScannedAt ?? "1970-01-01T00:00:00.000Z";
  return db.prepare(`
    SELECT m.id, m.sender_email, m.sender_name, m.subject, m.date_received, m.scanned_at,
           m.mailbox_id, mb.name AS mailbox_name, mb.account, s.category
    FROM messages m
    JOIN mailboxes mb ON m.mailbox_id = mb.id
    LEFT JOIN senders s ON LOWER(m.sender_email) = s.email
    WHERE m.scanned_at > ?
      AND mb.name NOT LIKE 'Sent%'
      AND mb.name NOT LIKE 'Drafts%'
      AND mb.name NOT LIKE 'Outbox%'
      AND mb.name NOT LIKE 'Trash%'
      AND mb.name NOT LIKE 'Deleted%'
    ORDER BY m.scanned_at ASC
    LIMIT ?
  `).all(since, limit) as TriageCandidate[];
}

export type ReviewReason =
  | "unknown_sender"
  | "low_confidence"
  | "proposed_rule"
  | "probably_not_spam"
  | "probably_spam";

export type ReviewStatus = "pending" | "decided" | "skipped";

export type ReviewAction =
  | "confirm_move"
  | "keep_inbox"
  | "mark_spam"
  | "not_spam"
  | "create_rule";

export interface ReviewQueueRow {
  id: number;
  message_id: string;
  mailbox_id: number | null;
  reason: ReviewReason;
  suggested_action: string | null;
  suggested_target: string | null;
  status: ReviewStatus;
  decided_at: string | null;
  decided_action: string | null;
  created_at: string;
}

export interface ReviewQueueInput {
  message_id: string;
  mailbox_id: number | null;
  reason: ReviewReason;
  suggested_action?: string | null;
  suggested_target?: string | null;
}

export function enqueueReview(input: ReviewQueueInput): boolean {
  const result = getDb().prepare(`
    INSERT OR IGNORE INTO review_queue
      (message_id, mailbox_id, reason, suggested_action, suggested_target, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(
    input.message_id,
    input.mailbox_id,
    input.reason,
    input.suggested_action ?? null,
    input.suggested_target ?? null,
    new Date().toISOString(),
  );
  return result.changes > 0;
}

export interface ReviewQueueRich extends ReviewQueueRow {
  subject: string | null;
  sender_email: string;
  sender_name: string | null;
  mailbox_name: string;
  account: string;
  date_received: string;
}

export function listReviewQueue(status: ReviewStatus = "pending", limit = 200): ReviewQueueRich[] {
  return getDb().prepare(`
    SELECT rq.*, m.subject, m.sender_email, m.sender_name, m.date_received,
           mb.name AS mailbox_name, mb.account
    FROM review_queue rq
    JOIN messages m ON rq.message_id = m.id
    LEFT JOIN mailboxes mb ON rq.mailbox_id = mb.id
    WHERE rq.status = ?
    ORDER BY rq.created_at DESC
    LIMIT ?
  `).all(status, limit) as ReviewQueueRich[];
}

export function getReviewQueueItem(id: number): ReviewQueueRich | null {
  const row = getDb().prepare(`
    SELECT rq.*, m.subject, m.sender_email, m.sender_name, m.date_received,
           mb.name AS mailbox_name, mb.account
    FROM review_queue rq
    JOIN messages m ON rq.message_id = m.id
    LEFT JOIN mailboxes mb ON rq.mailbox_id = mb.id
    WHERE rq.id = ?
  `).get(id) as ReviewQueueRich | undefined;
  return row ?? null;
}

export function setReviewDecided(id: number, action: ReviewAction) {
  getDb().prepare(`
    UPDATE review_queue
    SET status = 'decided', decided_at = ?, decided_action = ?
    WHERE id = ?
  `).run(new Date().toISOString(), action, id);
}

export function countPendingReview(): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) AS n FROM review_queue WHERE status = 'pending'`
  ).get() as { n: number };
  return row.n;
}

export function markMovesUndone(ids: number[]) {
  if (ids.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE move_log SET status = 'undone', undone_at = ? WHERE id IN (${placeholders})`
  ).run(now, ...ids);
}
