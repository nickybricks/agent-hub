/**
 * SSE wrapper around streamLoop. Emits one JSON object per `data:` frame:
 * thinking | token | tool | pending | final, then a terminal `done` carrying
 * the full transcript + any pending tool call. The whole turn is one LangSmith
 * `mail-analyzer.chat.turn` span (ac7).
 */

import { traceable } from "langsmith/traceable";
import { streamLoop, loadThreadState, type ChatEvent } from "./chat-agent";

export function chatStreamResponse(
  userId: string | null,
  threadId: number,
  signal: AbortSignal,
  meta: { turn_kind: "message" | "confirm" },
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      const toolsUsed: string[] = [];

      const drive = traceable(
        async () => {
          for await (const ev of streamLoop(userId, threadId, signal)) {
            if (ev.type === "tool" && ev.phase === "running") toolsUsed.push(ev.name);
            send(ev as ChatEvent);
          }
        },
        {
          name: "mail-analyzer.chat.turn",
          run_type: "chain",
          tags: ["mail-analyzer", "chat"],
          metadata: { thread_id: threadId, turn_kind: meta.turn_kind },
        },
      );

      try {
        await drive();
        const state = await loadThreadState(userId, threadId);
        send({ type: "done", threadId, ...state, tools_used: toolsUsed });
      } catch (err) {
        // "TypeError: fetch failed" hides the real reason in err.cause — unwrap
        // the cause chain so the surfaced message is actionable.
        let message = err instanceof Error ? err.message : "chat failed";
        let cause: unknown = (err as { cause?: unknown })?.cause;
        const seen = new Set<unknown>();
        while (cause && !seen.has(cause)) {
          seen.add(cause);
          const c = cause as { message?: string; code?: string; cause?: unknown };
          if (c.message || c.code) {
            message += ` — ${c.code ? `[${c.code}] ` : ""}${c.message ?? ""}`.trimEnd();
          }
          cause = c.cause;
        }
        console.error("[chat-stream] turn failed:", err);
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
