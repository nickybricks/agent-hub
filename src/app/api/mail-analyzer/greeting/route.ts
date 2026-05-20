/**
 * Proactive returning-user greeting. The /app shell POSTs here once on open for
 * an onboarded user; we compute what changed since their last visit, and — only
 * if there's something worth saying — append a warm companion message to their
 * most recent chat thread and hand it back for immediate render. Otherwise
 * `{ skip: true }` and the chat is left untouched.
 */

import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { buildGreeting } from "@/lib/greeting";
import { listThreadsPg, createThreadPg, appendMessagePg, touchThreadPg } from "@/lib/chat-db-pg";
import { describeError } from "@/lib/errcause";

export const dynamic = "force-dynamic";

export async function POST() {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = auth.userId;

  try {
    const greeting = await buildGreeting(userId);
    if (!greeting) return NextResponse.json({ skip: true });

    const threads = await listThreadsPg(userId, 1);
    const threadId = threads[0]?.id ?? (await createThreadPg(userId, "Welcome back"));
    await appendMessagePg(userId, {
      thread_id: threadId,
      role: "assistant",
      content: greeting.message,
    });
    await touchThreadPg(userId, threadId);

    return NextResponse.json({ message: greeting.message, threadId });
  } catch (e) {
    console.error("greeting error", e);
    return NextResponse.json({ skip: true, error: describeError(e) }, { status: 200 });
  }
}
