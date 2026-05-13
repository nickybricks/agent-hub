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
