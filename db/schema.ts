import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const waitlist = pgTable("waitlist", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  referrer: text("referrer"),
  locale: text("locale"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userSettings = pgTable("user_settings", {
  userId: uuid("user_id").primaryKey().notNull(),
  provider: text("provider").notNull().default("imap"),
  imapHost: text("imap_host"),
  imapPort: integer("imap_port"),
  imapUser: text("imap_user"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

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
    id: text("id").notNull(),
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
    // Tenant-scoped PK: a Message-ID is only unique within one user's mailbox.
    primaryKey({ columns: [t.userId, t.id] }),
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

export const triageRuns = pgTable("triage_runs", {
  id: serial("id").primaryKey(),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  messagesProcessed: integer("messages_processed"),
  messagesMoved: integer("messages_moved"),
  messagesQueued: integer("messages_queued"),
  watermark: text("watermark"),
  status: text("status"),
  error: text("error"),
  userId: uuid("user_id").notNull(),
  accountId: uuid("account_id"),
});

export const reviewQueue = pgTable(
  "review_queue",
  {
    id: serial("id").primaryKey(),
    messageId: text("message_id").notNull(),
    mailboxId: integer("mailbox_id").references(() => mailboxes.id),
    reason: text("reason").notNull(),
    suggestedAction: text("suggested_action"),
    suggestedTarget: text("suggested_target"),
    status: text("status").notNull().default("pending"),
    decidedAt: text("decided_at"),
    decidedAction: text("decided_action"),
    createdAt: text("created_at").notNull(),
    userId: uuid("user_id").notNull(),
    accountId: uuid("account_id"),
  },
  (t) => [
    index("idx_review_status").on(t.status),
    index("idx_review_reason").on(t.reason),
    unique("review_queue_msg_reason_user_idx").on(t.messageId, t.reason, t.userId),
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

// Phase 3.5 — agentic chat over the mailbox.

export const chatThreads = pgTable(
  "chat_threads",
  {
    id: serial("id").primaryKey(),
    title: text("title"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    userId: uuid("user_id").notNull(),
    accountId: uuid("account_id"),
  },
  (t) => [index("idx_chat_threads_user").on(t.userId, t.updatedAt)]
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: serial("id").primaryKey(),
    threadId: integer("thread_id")
      .notNull()
      .references(() => chatThreads.id),
    role: text("role").notNull(), // user | assistant | tool
    content: text("content"),
    // For tool result messages: which call this answers + its payload.
    toolCallRef: integer("tool_call_ref"),
    toolName: text("tool_name"),
    createdAt: text("created_at").notNull(),
    userId: uuid("user_id").notNull(),
    accountId: uuid("account_id"),
  },
  (t) => [index("idx_chat_messages_thread").on(t.threadId, t.id)]
);

// Agent-team Phase 5 — Telegram <-> PM agent conversation state.
// One row per open conversation thread. Operator-level data (single bot
// owner), so no user_id / RLS — server-only writes via service role.
export const pmConversations = pgTable(
  "pm_conversations",
  {
    id: serial("id").primaryKey(),
    telegramChatId: text("telegram_chat_id").notNull(),
    status: text("status").notNull().default("open"), // open | decided | closed
    proposedCardId: text("proposed_card_id"),
    decidedCardId: text("decided_card_id"),
    transcript: jsonb("transcript").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_pm_convos_chat_status").on(t.telegramChatId, t.status)],
);

export const toolCalls = pgTable(
  "tool_calls",
  {
    id: serial("id").primaryKey(),
    threadId: integer("thread_id")
      .notNull()
      .references(() => chatThreads.id),
    toolName: text("tool_name").notNull(),
    toolInput: text("tool_input").notNull(), // JSON
    // pending → awaiting user confirm; executed | cancelled | failed afterwards.
    status: text("status").notNull().default("pending"),
    preview: text("preview"), // JSON diff shown in the confirm card
    result: text("result"), // JSON result after execution
    reasoning: text("reasoning"), // agent's stated why, at request time
    createdAt: text("created_at").notNull(),
    decidedAt: text("decided_at"),
    userId: uuid("user_id").notNull(),
    accountId: uuid("account_id"),
  },
  (t) => [
    index("idx_tool_calls_thread").on(t.threadId, t.id),
    index("idx_tool_calls_status").on(t.status),
  ]
);
