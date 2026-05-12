import Database from "better-sqlite3";
import { join } from "path";
import { MailboxInfo, MailMessage } from "../agent/mail-imap";

const DB_PATH = join(process.cwd(), "data", "mail-analyzer.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  initSchema(_db);
  return _db;
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
  `);
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
    INSERT INTO messages (id, mailbox_id, sender_email, sender_name, subject, date_received, is_read, size_bytes, scanned_at)
    VALUES (@id, @mailboxId, @senderEmail, @senderName, @subject, @dateReceived, @isRead, @sizeBytes, @scannedAt)
    ON CONFLICT(id) DO UPDATE SET
      is_read = excluded.is_read,
      scanned_at = excluded.scanned_at
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

export function failScanRun(id: number, error: string) {
  getDb().prepare(`
    UPDATE scan_runs SET finished_at = ?, status = 'error', error = ? WHERE id = ?
  `).run(new Date().toISOString(), error, id);
}
