import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// Every tenant-scoped table gets user_id (required) and account_id (nullable
// during the migration grace period, to be filled in by a later task).

export const mailboxes = pgTable(
  "mailboxes",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    account: text("account").notNull(),
    messageCount: integer("message_count"),
    unreadCount: integer("unread_count"),
    lastScannedAt: text("last_scanned_at"),
    userId: uuid("user_id").notNull(),
    accountId: uuid("account_id"),
  },
  (t) => [unique("mailboxes_name_account_user_idx").on(t.name, t.account, t.userId)]
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    mailboxId: integer("mailbox_id").references(() => mailboxes.id),
    senderEmail: text("sender_email").notNull(),
    senderName: text("sender_name"),
    subject: text("subject"),
    dateReceived: text("date_received").notNull(),
    isRead: boolean("is_read").notNull(),
    sizeBytes: integer("size_bytes"),
    scannedAt: text("scanned_at").notNull(),
    headersJson: text("headers_json"),
    userId: uuid("user_id").notNull(),
    accountId: uuid("account_id"),
  },
  (t) => [
    index("idx_messages_sender").on(t.senderEmail),
    index("idx_messages_date").on(t.dateReceived),
    index("idx_messages_mailbox").on(t.mailboxId),
    index("idx_messages_user").on(t.userId),
  ]
);

// Multi-tenant: email uniqueness is per (email, user_id), not globally.
export const senders = pgTable(
  "senders",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull(),
    domain: text("domain").notNull(),
    displayName: text("display_name"),
    category: text("category"),
    classifiedAt: text("classified_at"),
    classificationModel: text("classification_model"),
    userId: uuid("user_id").notNull(),
    accountId: uuid("account_id"),
  },
  (t) => [unique("senders_email_user_idx").on(t.email, t.userId)]
);

export const scanRuns = pgTable("scan_runs", {
  id: serial("id").primaryKey(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  messagesScanned: integer("messages_scanned"),
  watermarkDate: text("watermark_date"),
  status: text("status"),
  error: text("error"),
  userId: uuid("user_id").notNull(),
  accountId: uuid("account_id"),
});

export const auditFindings = pgTable(
  "audit_findings",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    senderEmail: text("sender_email"),
    mailboxId: integer("mailbox_id").references(() => mailboxes.id),
    messageIdsJson: text("message_ids_json").notNull(),
    suggestedAction: text("suggested_action").notNull(),
    score: real("score").notNull(),
    reasoning: text("reasoning"),
    createdAt: text("created_at").notNull(),
    dismissedAt: text("dismissed_at"),
    userId: uuid("user_id").notNull(),
    accountId: uuid("account_id"),
  },
  (t) => [
    index("idx_findings_kind").on(t.kind),
    index("idx_findings_sender").on(t.senderEmail),
  ]
);

export const auditRuns = pgTable("audit_runs", {
  id: serial("id").primaryKey(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  findingsCount: integer("findings_count"),
  status: text("status"),
  error: text("error"),
  userId: uuid("user_id").notNull(),
  accountId: uuid("account_id"),
});

// Multi-tenant: (message_id, kind) unique per user.
export const auditMessageOverrides = pgTable(
  "audit_message_overrides",
  {
    id: serial("id").primaryKey(),
    messageId: text("message_id").notNull(),
    kind: text("kind").notNull(),
    decision: text("decision").notNull(),
    createdAt: text("created_at").notNull(),
    userId: uuid("user_id").notNull(),
    accountId: uuid("account_id"),
  },
  (t) => [unique("audit_overrides_msg_kind_user_idx").on(t.messageId, t.kind, t.userId)]
);

export const proposedFolders = pgTable("proposed_folders", {
  id: serial("id").primaryKey(),
  path: text("path").notNull(),
  rationale: text("rationale"),
  status: text("status").notNull().default("proposed"),
  createdAt: text("created_at").notNull(),
  decidedAt: text("decided_at"),
  userId: uuid("user_id").notNull(),
  accountId: uuid("account_id"),
});

export const folderRules = pgTable(
  "folder_rules",
  {
    id: serial("id").primaryKey(),
    matchType: text("match_type").notNull(),
    matchValue: text("match_value").notNull(),
    action: text("action").notNull(),
    targetFolder: text("target_folder"),
    status: text("status").notNull().default("proposed"),
    source: text("source").notNull(),
    confidence: real("confidence"),
    createdAt: text("created_at").notNull(),
    decidedAt: text("decided_at"),
    lastAppliedAt: text("last_applied_at"),
    userId: uuid("user_id").notNull(),
    accountId: uuid("account_id"),
  },
  (t) => [
    index("idx_rules_match").on(t.matchType, t.matchValue),
    index("idx_rules_status").on(t.status),
  ]
);

export const moveLog = pgTable(
  "move_log",
  {
    id: serial("id").primaryKey(),
    messageId: text("message_id").notNull(),
    fromMailbox: text("from_mailbox").notNull(),
    toMailbox: text("to_mailbox").notNull(),
    account: text("account").notNull(),
    provider: text("provider").notNull(),
    ruleId: integer("rule_id").references(() => folderRules.id),
    batchId: text("batch_id").notNull(),
    reason: text("reason"),
    status: text("status").notNull(),
    appliedAt: text("applied_at").notNull(),
    undoneAt: text("undone_at"),
    error: text("error"),
    userId: uuid("user_id").notNull(),
    accountId: uuid("account_id"),
  },
  (t) => [
    index("idx_movelog_batch").on(t.batchId),
    index("idx_movelog_message").on(t.messageId),
    index("idx_movelog_status").on(t.status),
  ]
);

export const agentMemory = pgTable(
  "agent_memory",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    key: text("key"),
    content: text("content").notNull(),
    source: text("source").notNull(),
    confidence: real("confidence"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
    supersededBy: integer("superseded_by"),
    userId: uuid("user_id").notNull(),
    accountId: uuid("account_id"),
  },
  (t) => [
    index("idx_memory_kind_key").on(t.kind, t.key),
    index("idx_memory_active").on(t.supersededBy),
  ]
);
