/**
 * SQLite-backed persistence for the Phase 3.5 agentic chat. Mirrors the
 * Postgres helpers in chat-db-pg.ts. Single-user path (MULTI_TENANT=false).
 */

import { getDb } from "./analyzer-db";
import { normalizeAskOptions, type AskOption } from "./chat-tools";

export type ChatRole = "user" | "assistant" | "tool";
export type ToolCallStatus = "pending" | "executed" | "cancelled" | "failed";

export interface ChatThread {
  id: number;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: number;
  thread_id: number;
  role: ChatRole;
  content: string | null;
  tool_call_ref: number | null;
  tool_name: string | null;
  created_at: string;
}

export interface ToolCallRow {
  id: number;
  thread_id: number;
  tool_name: string;
  tool_input: string;
  status: ToolCallStatus;
  preview: string | null;
  result: string | null;
  reasoning: string | null;
  created_at: string;
  decided_at: string | null;
}

export function createThread(title?: string | null): number {
  const db = getDb();
  const now = new Date().toISOString();
  const info = db
    .prepare(`INSERT INTO chat_threads (title, created_at, updated_at) VALUES (?, ?, ?)`)
    .run(title ?? null, now, now);
  return Number(info.lastInsertRowid);
}

export function listThreads(limit = 30): ChatThread[] {
  return getDb()
    .prepare(`SELECT * FROM chat_threads ORDER BY updated_at DESC LIMIT ?`)
    .all(limit) as ChatThread[];
}

export function getThread(id: number): ChatThread | null {
  return (getDb().prepare(`SELECT * FROM chat_threads WHERE id = ?`).get(id) as ChatThread) ?? null;
}

export function touchThread(id: number): void {
  getDb()
    .prepare(`UPDATE chat_threads SET updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), id);
}

export function appendMessage(m: {
  thread_id: number;
  role: ChatRole;
  content?: string | null;
  tool_call_ref?: number | null;
  tool_name?: string | null;
}): number {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO chat_messages (thread_id, role, content, tool_call_ref, tool_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      m.thread_id,
      m.role,
      m.content ?? null,
      m.tool_call_ref ?? null,
      m.tool_name ?? null,
      new Date().toISOString(),
    );
  return Number(info.lastInsertRowid);
}

export function listMessages(threadId: number): ChatMessage[] {
  return getDb()
    .prepare(`SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY id`)
    .all(threadId) as ChatMessage[];
}

export function createToolCall(c: {
  thread_id: number;
  tool_name: string;
  tool_input: string;
  preview?: string | null;
  reasoning?: string | null;
}): number {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO tool_calls (thread_id, tool_name, tool_input, status, preview, reasoning, created_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(
      c.thread_id,
      c.tool_name,
      c.tool_input,
      c.preview ?? null,
      c.reasoning ?? null,
      new Date().toISOString(),
    );
  return Number(info.lastInsertRowid);
}

export function getToolCall(id: number): ToolCallRow | null {
  return (getDb().prepare(`SELECT * FROM tool_calls WHERE id = ?`).get(id) as ToolCallRow) ?? null;
}

export function getPendingToolCall(threadId: number): ToolCallRow | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM tool_calls WHERE thread_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`)
      .get(threadId) as ToolCallRow) ?? null
  );
}

// Pending ask_user (question + options) — survives reload. Status 'asking'
// keeps it out of the confirm-card 'pending' query above.
export function savePendingAsk(
  threadId: number,
  question: string,
  options: AskOption[],
): void {
  getDb()
    .prepare(
      `INSERT INTO tool_calls (thread_id, tool_name, tool_input, status, created_at)
       VALUES (?, 'ask_user', ?, 'asking', ?)`,
    )
    .run(threadId, JSON.stringify({ question, options }), new Date().toISOString());
}

export function getPendingAsk(
  threadId: number,
): { question: string; options: AskOption[] } | null {
  const r = getDb()
    .prepare(
      `SELECT tool_input FROM tool_calls WHERE thread_id = ? AND status = 'asking' ORDER BY id DESC LIMIT 1`,
    )
    .get(threadId) as { tool_input: string } | undefined;
  if (!r) return null;
  try {
    const p = JSON.parse(r.tool_input) as { question: string; options: unknown };
    return { question: p.question, options: normalizeAskOptions(p.options) };
  } catch {
    return null;
  }
}

export function clearPendingAsks(threadId: number): void {
  getDb()
    .prepare(
      `UPDATE tool_calls SET status = 'cancelled', decided_at = ? WHERE thread_id = ? AND status = 'asking'`,
    )
    .run(new Date().toISOString(), threadId);
}

export function finishToolCall(
  id: number,
  status: Exclude<ToolCallStatus, "pending">,
  result?: string | null,
): void {
  getDb()
    .prepare(`UPDATE tool_calls SET status = ?, result = ?, decided_at = ? WHERE id = ?`)
    .run(status, result ?? null, new Date().toISOString(), id);
}
