import { NextResponse } from "next/server";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { executeMutation } from "@/lib/chat-tools";
import { runLoop, getToolCall, finishToolCall, persistMemory } from "@/lib/chat-agent";
import * as sq from "@/lib/chat-db";
import * as pg from "@/lib/chat-db-pg";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const appendMessage = (u: string | null, m: Parameters<typeof sq.appendMessage>[0]) =>
  u ? pg.appendMessagePg(u, m) : Promise.resolve(sq.appendMessage(m));
const listMessages = (u: string | null, id: number) =>
  u ? pg.listMessagesPg(u, id) : Promise.resolve(sq.listMessages(id));

export async function POST(req: Request) {
  let userId: string | null = null;
  if (isMultiTenant()) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    userId = user.id;
  }

  const body = (await req.json().catch(() => null)) as
    | { toolCallId?: number; decision?: "apply" | "cancel" }
    | null;
  const toolCallId = body?.toolCallId;
  const decision = body?.decision;
  if (!toolCallId || (decision !== "apply" && decision !== "cancel")) {
    return NextResponse.json({ error: "toolCallId and decision (apply|cancel) required" }, { status: 400 });
  }

  const tc = await getToolCall(userId, toolCallId);
  if (!tc) return NextResponse.json({ error: "tool call not found" }, { status: 404 });
  if (tc.status !== "pending") {
    return NextResponse.json({ error: `tool call already ${tc.status}` }, { status: 409 });
  }

  const input = JSON.parse(tc.tool_input) as Record<string, unknown>;
  const threadId = tc.thread_id;

  if (decision === "cancel") {
    await finishToolCall(userId, tc.id, "cancelled");
    await appendMessage(userId, {
      thread_id: threadId,
      role: "tool",
      tool_name: tc.tool_name,
      content: `User declined to run ${tc.tool_name}.`,
    });
    await persistMemory(
      userId,
      `User declined ${tc.tool_name}(${tc.tool_input}). Agent reasoning at the time: ${tc.reasoning ?? "(none)"}.`,
      tc.tool_name,
    );
  } else {
    try {
      const result = await executeMutation(userId, tc.tool_name, input);
      const json = JSON.stringify(result);
      await finishToolCall(userId, tc.id, "executed", json);
      await appendMessage(userId, {
        thread_id: threadId,
        role: "tool",
        tool_name: tc.tool_name,
        content: `${tc.tool_name} executed. Result: ${json}`,
      });
      await persistMemory(
        userId,
        `User confirmed ${tc.tool_name}(${tc.tool_input}). Agent reasoning: ${tc.reasoning ?? "(none)"}. Result: ${json}.`,
        tc.tool_name,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await finishToolCall(userId, tc.id, "failed", JSON.stringify({ error: msg }));
      await appendMessage(userId, {
        thread_id: threadId,
        role: "tool",
        tool_name: tc.tool_name,
        content: `${tc.tool_name} failed: ${msg}`,
      });
    }
  }

  try {
    const result = await runLoop(userId, threadId);
    const messages = await listMessages(userId, threadId);
    return NextResponse.json({ threadId, messages, pending: result.pending });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "chat failed" },
      { status: 500 },
    );
  }
}
