/**
 * Proactive returning-user greeting. The /app shell POSTs here once on open for
 * an onboarded user; we compute what changed since their last visit, and — only
 * if there's something worth saying — append a warm companion message to their
 * most recent chat thread and hand it back for immediate render. Otherwise
 * `{ skip: true }` and the chat is left untouched.
 */

import { NextResponse } from "next/server";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { buildGreeting } from "@/lib/greeting";
import { listThreadsPg, createThreadPg, appendMessagePg, touchThreadPg } from "@/lib/chat-db-pg";
import { describeError } from "@/lib/errcause";

export const dynamic = "force-dynamic";

export async function POST() {
  if (!isMultiTenant()) return NextResponse.json({ skip: true });

  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const greeting = await buildGreeting(user.id);
    if (!greeting) return NextResponse.json({ skip: true });

    const threads = await listThreadsPg(user.id, 1);
    const threadId = threads[0]?.id ?? (await createThreadPg(user.id, "Welcome back"));
    await appendMessagePg(user.id, {
      thread_id: threadId,
      role: "assistant",
      content: greeting.message,
    });
    await touchThreadPg(user.id, threadId);

    return NextResponse.json({ message: greeting.message, threadId });
  } catch (e) {
    console.error("greeting error", e);
    return NextResponse.json({ skip: true, error: describeError(e) }, { status: 200 });
  }
}
