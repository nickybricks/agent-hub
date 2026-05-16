/**
 * Postgres-backed persistence for the Phase 3.5 agentic chat (MULTI_TENANT=true).
 * Mirrors chat-db.ts; every function takes the tenant userId and filters on it.
 *
 * Service-role DATABASE_URL bypasses RLS — explicit user_id filters are mandatory.
 */

import { getDrizzleDb } from "./db";
import { sql } from "drizzle-orm";
import type { ChatThread, ChatMessage, ChatRole, ToolCallRow, ToolCallStatus } from "./chat-db";

export async function createThreadPg(userId: string, title?: string | null): Promise<number> {
  const db = getDrizzleDb();
  const now = new Date().toISOString();
  const rows = await db.execute(sql`
    INSERT INTO chat_threads (title, created_at, updated_at, user_id)
    VALUES (${title ?? null}, ${now}, ${now}, ${userId})
    RETURNING id
  `);
  return Number((rows[0] as { id: number }).id);
}

export async function listThreadsPg(userId: string, limit = 30): Promise<ChatThread[]> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT id, title, created_at, updated_at FROM chat_threads
    WHERE user_id = ${userId} ORDER BY updated_at DESC LIMIT ${limit}
  `);
  return rows as unknown as ChatThread[];
}

export async function getThreadPg(userId: string, id: number): Promise<ChatThread | null> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT id, title, created_at, updated_at FROM chat_threads
    WHERE id = ${id} AND user_id = ${userId}
  `);
  return (rows[0] as unknown as ChatThread) ?? null;
}

export async function touchThreadPg(userId: string, id: number): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    UPDATE chat_threads SET updated_at = ${new Date().toISOString()}
    WHERE id = ${id} AND user_id = ${userId}
  `);
}

export async function appendMessagePg(
  userId: string,
  m: {
    thread_id: number;
    role: ChatRole;
    content?: string | null;
    tool_call_ref?: number | null;
    tool_name?: string | null;
  },
): Promise<number> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    INSERT INTO chat_messages (thread_id, role, content, tool_call_ref, tool_name, created_at, user_id)
    VALUES (${m.thread_id}, ${m.role}, ${m.content ?? null}, ${m.tool_call_ref ?? null},
            ${m.tool_name ?? null}, ${new Date().toISOString()}, ${userId})
    RETURNING id
  `);
  return Number((rows[0] as { id: number }).id);
}

export async function listMessagesPg(userId: string, threadId: number): Promise<ChatMessage[]> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT id, thread_id, role, content, tool_call_ref, tool_name, created_at
    FROM chat_messages WHERE thread_id = ${threadId} AND user_id = ${userId} ORDER BY id
  `);
  return rows as unknown as ChatMessage[];
}

export async function createToolCallPg(
  userId: string,
  c: {
    thread_id: number;
    tool_name: string;
    tool_input: string;
    preview?: string | null;
    reasoning?: string | null;
  },
): Promise<number> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    INSERT INTO tool_calls (thread_id, tool_name, tool_input, status, preview, reasoning, created_at, user_id)
    VALUES (${c.thread_id}, ${c.tool_name}, ${c.tool_input}, 'pending',
            ${c.preview ?? null}, ${c.reasoning ?? null}, ${new Date().toISOString()}, ${userId})
    RETURNING id
  `);
  return Number((rows[0] as { id: number }).id);
}

export async function getToolCallPg(userId: string, id: number): Promise<ToolCallRow | null> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT id, thread_id, tool_name, tool_input, status, preview, result, reasoning, created_at, decided_at
    FROM tool_calls WHERE id = ${id} AND user_id = ${userId}
  `);
  return (rows[0] as unknown as ToolCallRow) ?? null;
}

export async function getPendingToolCallPg(
  userId: string,
  threadId: number,
): Promise<ToolCallRow | null> {
  const db = getDrizzleDb();
  const rows = await db.execute(sql`
    SELECT id, thread_id, tool_name, tool_input, status, preview, result, reasoning, created_at, decided_at
    FROM tool_calls
    WHERE thread_id = ${threadId} AND user_id = ${userId} AND status = 'pending'
    ORDER BY id DESC LIMIT 1
  `);
  return (rows[0] as unknown as ToolCallRow) ?? null;
}

export async function finishToolCallPg(
  userId: string,
  id: number,
  status: Exclude<ToolCallStatus, "pending">,
  result?: string | null,
): Promise<void> {
  const db = getDrizzleDb();
  await db.execute(sql`
    UPDATE tool_calls
    SET status = ${status}, result = ${result ?? null}, decided_at = ${new Date().toISOString()}
    WHERE id = ${id} AND user_id = ${userId}
  `);
}
