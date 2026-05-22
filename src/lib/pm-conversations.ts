/**
 * Persistence for the Telegram <-> PM agent conversation thread.
 * Operator-level data (single bot owner) — no user_id, no RLS, server only.
 */

import { sql } from "drizzle-orm";
import { getDrizzleDb } from "./db";

export type TranscriptTurn = {
  role: "user" | "pm" | "system";
  text: string;
  ts: string;
};

export type PmConversation = {
  id: number;
  telegramChatId: string;
  status: "open" | "decided" | "closed";
  proposedCardId: string | null;
  decidedCardId: string | null;
  transcript: TranscriptTurn[];
};

type Row = {
  id: number;
  telegram_chat_id: string;
  status: string;
  proposed_card_id: string | null;
  decided_card_id: string | null;
  transcript: TranscriptTurn[] | null;
};

function toConversation(r: Row): PmConversation {
  return {
    id: r.id,
    telegramChatId: r.telegram_chat_id,
    status: r.status as PmConversation["status"],
    proposedCardId: r.proposed_card_id,
    decidedCardId: r.decided_card_id,
    transcript: r.transcript ?? [],
  };
}

export async function getOpenConversation(
  chatId: string,
): Promise<PmConversation | null> {
  const db = getDrizzleDb();
  const rows = (await db.execute(sql`
    SELECT id, telegram_chat_id, status, proposed_card_id, decided_card_id, transcript
    FROM pm_conversations
    WHERE telegram_chat_id = ${chatId} AND status = 'open'
    ORDER BY id DESC LIMIT 1
  `)) as unknown as Row[];
  return rows[0] ? toConversation(rows[0]) : null;
}

export async function getOrCreateOpenConversation(
  chatId: string,
): Promise<PmConversation> {
  const existing = await getOpenConversation(chatId);
  if (existing) return existing;
  const db = getDrizzleDb();
  const rows = (await db.execute(sql`
    INSERT INTO pm_conversations (telegram_chat_id)
    VALUES (${chatId})
    RETURNING id, telegram_chat_id, status, proposed_card_id, decided_card_id, transcript
  `)) as unknown as Row[];
  return toConversation(rows[0]);
}

export async function appendTurn(
  conversationId: number,
  turn: TranscriptTurn,
): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    UPDATE pm_conversations
    SET transcript = transcript || ${JSON.stringify([turn])}::jsonb,
        updated_at = now()
    WHERE id = ${conversationId}
  `);
}

export async function setProposedCard(
  conversationId: number,
  cardId: string | null,
): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    UPDATE pm_conversations
    SET proposed_card_id = ${cardId}, updated_at = now()
    WHERE id = ${conversationId}
  `);
}

export async function markDecided(
  conversationId: number,
  cardId: string,
): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    UPDATE pm_conversations
    SET status = 'decided', decided_card_id = ${cardId}, updated_at = now()
    WHERE id = ${conversationId}
  `);
}
