/**
 * One-shot migration: dumps the local SQLite mail-analyzer.db into Supabase Postgres
 * under a single DEV_USER_ID. Idempotent (truncates tables before inserting).
 *
 * Usage:
 *   DEV_USER_ID=<your-supabase-uuid> npx tsx --env-file=.env.local scripts/migrate-sqlite-to-postgres.ts
 *
 * DEV_USER_ID is your Supabase user UUID — find it in Supabase dashboard
 * under Authentication > Users.
 */

import Database from "better-sqlite3";
import postgres from "postgres";
import { join } from "path";

const DEV_USER_ID = process.env.DEV_USER_ID;
if (!DEV_USER_ID) { console.error("DEV_USER_ID is required"); process.exit(1); }

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(1); }

const sqlite = new Database(join(process.cwd(), "data", "mail-analyzer.db"), { readonly: true });
const pg = postgres(DATABASE_URL, { max: 1 });

const BATCH = 500;

// Postgres rejects null bytes in UTF-8 text columns — common in email data.
const clean = (s: string | null | undefined): string | null =>
  s == null ? null : s.replace(/\0/g, "");

// postgres.js pg(rows) generates ("col1","col2") VALUES (...) so use INSERT INTO table ${pg(rows)}
async function insertBatched<T extends Record<string, unknown>>(
  label: string,
  rows: T[],
  insert: (batch: T[]) => Promise<unknown>,
) {
  if (!rows.length) { console.log(`  ${label}: 0 (skipped)`); return; }
  for (let i = 0; i < rows.length; i += BATCH) {
    await insert(rows.slice(i, i + BATCH));
    process.stdout.write(`\r  ${label}: ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
  }
  console.log();
}

async function migrate() {
  console.log(`Migrating SQLite → Postgres as user ${DEV_USER_ID}\n`);

  await pg`TRUNCATE agent_memory, move_log, folder_rules, proposed_folders,
    audit_message_overrides, audit_runs, audit_findings, scan_runs,
    senders, messages, mailboxes RESTART IDENTITY CASCADE`;
  console.log("Truncated all tables.\n");

  // mailboxes
  const mailboxes = sqlite.prepare("SELECT * FROM mailboxes").all() as {
    id: number; name: string; account: string; message_count: number | null;
    unread_count: number | null; last_scanned_at: string | null;
  }[];
  await insertBatched("mailboxes", mailboxes, (batch) =>
    pg`INSERT INTO mailboxes ${pg(batch.map((r) => ({
      id: r.id, name: r.name, account: r.account,
      message_count: r.message_count ?? null,
      unread_count: r.unread_count ?? null,
      last_scanned_at: r.last_scanned_at ?? null,
      user_id: DEV_USER_ID,
    })))}`
  );
  if (mailboxes.length) {
    await pg`SELECT setval('mailboxes_id_seq', (SELECT MAX(id) FROM mailboxes))`;
  }

  // senders
  const senders = sqlite.prepare("SELECT * FROM senders").all() as {
    email: string; domain: string; display_name: string | null;
    category: string | null; classified_at: string | null; classification_model: string | null;
  }[];
  await insertBatched("senders", senders, (batch) =>
    pg`INSERT INTO senders ${pg(batch.map((r) => ({
      email: r.email, domain: r.domain,
      display_name: clean(r.display_name),
      category: r.category ?? null,
      classified_at: r.classified_at ?? null,
      classification_model: r.classification_model ?? null,
      user_id: DEV_USER_ID,
    })))}`
  );

  // messages (large — batch in 500s)
  const msgCount = (sqlite.prepare("SELECT COUNT(*) as n FROM messages").get() as { n: number }).n;
  process.stdout.write(`  messages: 0/${msgCount}`);
  let msgOffset = 0;
  while (msgOffset < msgCount) {
    const rows = sqlite.prepare("SELECT * FROM messages LIMIT 500 OFFSET ?").all(msgOffset) as {
      id: string; mailbox_id: number | null; sender_email: string; sender_name: string | null;
      subject: string | null; date_received: string; is_read: number; size_bytes: number | null;
      scanned_at: string; headers_json: string | null;
    }[];
    await pg`INSERT INTO messages ${pg(rows.map((r) => ({
      id: r.id,
      mailbox_id: r.mailbox_id ?? null,
      sender_email: clean(r.sender_email)!,
      sender_name: clean(r.sender_name),
      subject: clean(r.subject),
      date_received: r.date_received,
      is_read: Boolean(r.is_read),
      size_bytes: r.size_bytes ?? null,
      scanned_at: r.scanned_at,
      headers_json: clean(r.headers_json),
      user_id: DEV_USER_ID,
    })))} ON CONFLICT (id) DO NOTHING`;
    msgOffset += rows.length;
    process.stdout.write(`\r  messages: ${msgOffset}/${msgCount}`);
  }
  console.log();

  // scan_runs
  const scanRuns = sqlite.prepare("SELECT * FROM scan_runs").all() as {
    id: number; started_at: string; finished_at: string | null; messages_scanned: number | null;
    watermark_date: string | null; status: string | null; error: string | null;
  }[];
  await insertBatched("scan_runs", scanRuns, (batch) =>
    pg`INSERT INTO scan_runs ${pg(batch.map((r) => ({
      id: r.id, started_at: r.started_at,
      finished_at: r.finished_at ?? null,
      messages_scanned: r.messages_scanned ?? null,
      watermark_date: r.watermark_date ?? null,
      status: r.status ?? null,
      error: r.error ?? null,
      user_id: DEV_USER_ID,
    })))}`
  );
  if (scanRuns.length) {
    await pg`SELECT setval('scan_runs_id_seq', (SELECT MAX(id) FROM scan_runs))`;
  }

  // audit_findings
  const findings = sqlite.prepare("SELECT * FROM audit_findings").all() as {
    id: number; kind: string; sender_email: string | null; mailbox_id: number | null;
    message_ids_json: string; suggested_action: string; score: number; reasoning: string | null;
    created_at: string; dismissed_at: string | null;
  }[];
  await insertBatched("audit_findings", findings, (batch) =>
    pg`INSERT INTO audit_findings ${pg(batch.map((r) => ({
      id: r.id, kind: r.kind,
      sender_email: r.sender_email ?? null,
      mailbox_id: r.mailbox_id ?? null,
      message_ids_json: r.message_ids_json,
      suggested_action: r.suggested_action,
      score: r.score,
      reasoning: r.reasoning ?? null,
      created_at: r.created_at,
      dismissed_at: r.dismissed_at ?? null,
      user_id: DEV_USER_ID,
    })))}`
  );
  if (findings.length) {
    await pg`SELECT setval('audit_findings_id_seq', (SELECT MAX(id) FROM audit_findings))`;
  }

  // audit_runs
  const auditRuns = sqlite.prepare("SELECT * FROM audit_runs").all() as {
    id: number; started_at: string; finished_at: string | null;
    findings_count: number | null; status: string | null; error: string | null;
  }[];
  await insertBatched("audit_runs", auditRuns, (batch) =>
    pg`INSERT INTO audit_runs ${pg(batch.map((r) => ({
      id: r.id, started_at: r.started_at,
      finished_at: r.finished_at ?? null,
      findings_count: r.findings_count ?? null,
      status: r.status ?? null,
      error: r.error ?? null,
      user_id: DEV_USER_ID,
    })))}`
  );
  if (auditRuns.length) {
    await pg`SELECT setval('audit_runs_id_seq', (SELECT MAX(id) FROM audit_runs))`;
  }

  // audit_message_overrides
  const overrides = sqlite.prepare("SELECT * FROM audit_message_overrides").all() as {
    message_id: string; kind: string; decision: string; created_at: string;
  }[];
  await insertBatched("audit_message_overrides", overrides, (batch) =>
    pg`INSERT INTO audit_message_overrides ${pg(batch.map((r) => ({
      message_id: r.message_id, kind: r.kind, decision: r.decision,
      created_at: r.created_at, user_id: DEV_USER_ID,
    })))}`
  );

  // proposed_folders
  const folders = sqlite.prepare("SELECT * FROM proposed_folders").all() as {
    id: number; path: string; rationale: string | null; status: string;
    created_at: string; decided_at: string | null;
  }[];
  await insertBatched("proposed_folders", folders, (batch) =>
    pg`INSERT INTO proposed_folders ${pg(batch.map((r) => ({
      id: r.id, path: r.path, rationale: r.rationale ?? null,
      status: r.status, created_at: r.created_at, decided_at: r.decided_at ?? null,
      user_id: DEV_USER_ID,
    })))}`
  );
  if (folders.length) {
    await pg`SELECT setval('proposed_folders_id_seq', (SELECT MAX(id) FROM proposed_folders))`;
  }

  // folder_rules
  const rules = sqlite.prepare("SELECT * FROM folder_rules").all() as {
    id: number; match_type: string; match_value: string; action: string;
    target_folder: string | null; status: string; source: string; confidence: number | null;
    created_at: string; decided_at: string | null; last_applied_at: string | null;
  }[];
  await insertBatched("folder_rules", rules, (batch) =>
    pg`INSERT INTO folder_rules ${pg(batch.map((r) => ({
      id: r.id, match_type: r.match_type, match_value: r.match_value,
      action: r.action, target_folder: r.target_folder ?? null,
      status: r.status, source: r.source, confidence: r.confidence ?? null,
      created_at: r.created_at, decided_at: r.decided_at ?? null,
      last_applied_at: r.last_applied_at ?? null,
      user_id: DEV_USER_ID,
    })))}`
  );
  if (rules.length) {
    await pg`SELECT setval('folder_rules_id_seq', (SELECT MAX(id) FROM folder_rules))`;
  }

  // move_log
  const moves = sqlite.prepare("SELECT * FROM move_log").all() as {
    id: number; message_id: string; from_mailbox: string; to_mailbox: string;
    account: string; provider: string; rule_id: number | null; batch_id: string;
    reason: string | null; status: string; applied_at: string; undone_at: string | null; error: string | null;
  }[];
  await insertBatched("move_log", moves, (batch) =>
    pg`INSERT INTO move_log ${pg(batch.map((r) => ({
      id: r.id, message_id: r.message_id, from_mailbox: r.from_mailbox,
      to_mailbox: r.to_mailbox, account: r.account, provider: r.provider,
      rule_id: r.rule_id ?? null, batch_id: r.batch_id, reason: r.reason ?? null,
      status: r.status, applied_at: r.applied_at, undone_at: r.undone_at ?? null,
      error: r.error ?? null, user_id: DEV_USER_ID,
    })))}`
  );
  if (moves.length) {
    await pg`SELECT setval('move_log_id_seq', (SELECT MAX(id) FROM move_log))`;
  }

  // agent_memory
  const memories = sqlite.prepare("SELECT * FROM agent_memory").all() as {
    id: number; kind: string; key: string | null; content: string; source: string;
    confidence: number | null; created_at: string; last_used_at: string | null; superseded_by: number | null;
  }[];
  await insertBatched("agent_memory", memories, (batch) =>
    pg`INSERT INTO agent_memory ${pg(batch.map((r) => ({
      id: r.id, kind: r.kind, key: r.key ?? null, content: r.content,
      source: r.source, confidence: r.confidence ?? null,
      created_at: r.created_at, last_used_at: r.last_used_at ?? null,
      superseded_by: r.superseded_by ?? null, user_id: DEV_USER_ID,
    })))}`
  );
  if (memories.length) {
    await pg`SELECT setval('agent_memory_id_seq', (SELECT MAX(id) FROM agent_memory))`;
  }

  console.log("\nMigration complete.");
  await pg.end();
  sqlite.close();
}

migrate().catch((e) => {
  console.error("\nMigration failed:", e);
  process.exit(1);
});
