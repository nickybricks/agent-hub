-- Agent-team Phase 5: Telegram <-> PM agent conversation state.
-- One row per open conversation thread per Telegram chat. Operator-level
-- data (single bot owner), not multi-tenant — no user_id, no RLS.
-- Apply in Supabase SQL Editor or: psql $DATABASE_URL -f db/migrations/0007_pm_conversations.sql

CREATE TABLE IF NOT EXISTS "pm_conversations" (
  "id"                serial      PRIMARY KEY,
  "telegram_chat_id"  text        NOT NULL,
  "status"            text        NOT NULL DEFAULT 'open',
  "proposed_card_id"  text,
  "decided_card_id"   text,
  "transcript"        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_pm_convos_chat_status"
  ON "pm_conversations" ("telegram_chat_id", "status");
