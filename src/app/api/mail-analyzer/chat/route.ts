import { NextResponse } from "next/server";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit, ipFromRequest } from "@/lib/rate-limit";
import { chatStreamResponse } from "@/lib/chat-stream";
import * as sq from "@/lib/chat-db";
import * as pg from "@/lib/chat-db-pg";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function resolveUser(): Promise<string | null | { error: NextResponse }> {
  if (!isMultiTenant()) return null;
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  return user.id;
}

const listThreads = (u: string | null) =>
  u ? pg.listThreadsPg(u) : Promise.resolve(sq.listThreads());
const getThread = (u: string | null, id: number) =>
  u ? pg.getThreadPg(u, id) : Promise.resolve(sq.getThread(id));
const listMessages = (u: string | null, id: number) =>
  u ? pg.listMessagesPg(u, id) : Promise.resolve(sq.listMessages(id));
const createThread = (u: string | null, title: string) =>
  u ? pg.createThreadPg(u, title) : Promise.resolve(sq.createThread(title));
const appendMessage = (u: string | null, m: Parameters<typeof sq.appendMessage>[0]) =>
  u ? pg.appendMessagePg(u, m) : Promise.resolve(sq.appendMessage(m));
const getPendingToolCall = (u: string | null, threadId: number) =>
  u ? pg.getPendingToolCallPg(u, threadId) : Promise.resolve(sq.getPendingToolCall(threadId));

// List threads, or (with ?threadId=) one thread's transcript + any pending tool call.
export async function GET(req: Request) {
  const u = await resolveUser();
  if (u && typeof u === "object") return u.error;
  const userId = u as string | null;

  const threadId = Number(new URL(req.url).searchParams.get("threadId"));
  if (!threadId) {
    return NextResponse.json({ threads: await listThreads(userId) });
  }

  const thread = await getThread(userId, threadId);
  if (!thread) return NextResponse.json({ error: "thread not found" }, { status: 404 });
  const messages = await listMessages(userId, threadId);

  // Surface the still-pending tool call so a reload can resume the confirm card.
  const pendingRow = await getPendingToolCall(userId, threadId);
  const pending = pendingRow
    ? {
        id: pendingRow.id,
        tool_name: pendingRow.tool_name,
        input: JSON.parse(pendingRow.tool_input),
        summary: pendingRow.preview ? JSON.parse(pendingRow.preview).summary : pendingRow.tool_name,
      }
    : null;

  return NextResponse.json({ thread, messages, pending });
}

export async function POST(req: Request) {
  const rl = await checkRateLimit(`chat:${ipFromRequest(req)}`, 20, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests", retryAfter: rl.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const u = await resolveUser();
  if (u && typeof u === "object") return u.error;
  const userId = u as string | null;

  const body = (await req.json().catch(() => null)) as
    | { threadId?: number; message?: string }
    | null;
  const message = body?.message?.trim();
  if (!message) return NextResponse.json({ error: "message required" }, { status: 400 });

  let threadId = body?.threadId;
  if (threadId) {
    const t = await getThread(userId, threadId);
    if (!t) return NextResponse.json({ error: "thread not found" }, { status: 404 });
  } else {
    threadId = await createThread(userId, message.slice(0, 60));
  }

  await appendMessage(userId, { thread_id: threadId, role: "user", content: message });

  return chatStreamResponse(userId, threadId, req.signal, { turn_kind: "message" });
}
