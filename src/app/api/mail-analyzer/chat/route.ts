import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { checkRateLimit, ipFromRequest } from "@/lib/rate-limit";
import { chatStreamResponse } from "@/lib/chat-stream";
import {
  listThreadsPg,
  getThreadPg,
  listMessagesPg,
  createThreadPg,
  appendMessagePg,
  getPendingToolCallPg,
  getPendingAskPg,
} from "@/lib/chat-db-pg";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// List threads, or (with ?threadId=) one thread's transcript + any pending tool call.
export async function GET(req: Request) {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = auth.userId;

  const threadId = Number(new URL(req.url).searchParams.get("threadId"));
  if (!threadId) {
    return NextResponse.json({ threads: await listThreadsPg(userId) });
  }

  const thread = await getThreadPg(userId, threadId);
  if (!thread) return NextResponse.json({ error: "thread not found" }, { status: 404 });
  const messages = await listMessagesPg(userId, threadId);

  // Surface the still-pending tool call so a reload can resume the confirm card.
  const pendingRow = await getPendingToolCallPg(userId, threadId);
  const pending = pendingRow
    ? {
        id: pendingRow.id,
        tool_name: pendingRow.tool_name,
        input: JSON.parse(pendingRow.tool_input),
        summary: pendingRow.preview ? JSON.parse(pendingRow.preview).summary : pendingRow.tool_name,
      }
    : null;

  // Resurface a still-open ask_user so the option buttons survive a reload
  // (and a returning-user greeting that reloads the thread).
  const asking = await getPendingAskPg(userId, threadId);

  return NextResponse.json({ thread, messages, pending, asking });
}

export async function POST(req: Request) {
  const rl = await checkRateLimit(`chat:${ipFromRequest(req)}`, 20, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests", retryAfter: rl.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = auth.userId;

  const body = (await req.json().catch(() => null)) as
    | { threadId?: number; message?: string }
    | null;
  const message = body?.message?.trim();
  if (!message) return NextResponse.json({ error: "message required" }, { status: 400 });

  let threadId = body?.threadId;
  if (threadId) {
    const t = await getThreadPg(userId, threadId);
    if (!t) return NextResponse.json({ error: "thread not found" }, { status: 404 });
  } else {
    threadId = await createThreadPg(userId, message.slice(0, 60));
  }

  await appendMessagePg(userId, { thread_id: threadId, role: "user", content: message });

  return chatStreamResponse(userId, threadId, req.signal, { turn_kind: "message" });
}
