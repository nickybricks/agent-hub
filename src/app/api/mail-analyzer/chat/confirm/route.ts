import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { executeMutation } from "@/lib/chat-tools";
import { getToolCall, finishToolCall, persistMemory } from "@/lib/chat-agent";
import { chatStreamResponse } from "@/lib/chat-stream";
import { appendMessagePg } from "@/lib/chat-db-pg";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = auth.userId;

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
    await appendMessagePg(userId, {
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
      await appendMessagePg(userId, {
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
      await appendMessagePg(userId, {
        thread_id: threadId,
        role: "tool",
        tool_name: tc.tool_name,
        content: `${tc.tool_name} failed: ${msg}`,
      });
    }
  }

  return chatStreamResponse(userId, threadId, req.signal, { turn_kind: "confirm" });
}
