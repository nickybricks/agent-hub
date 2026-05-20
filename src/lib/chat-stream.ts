/**
 * SSE wrapper around streamLoop. Emits one JSON object per `data:` frame:
 * thinking | token | tool | pending | final, then a terminal `done` carrying
 * the full transcript + any pending tool call. The whole turn is one LangSmith
 * `mail-analyzer.chat.turn` span (ac7).
 */

import { traceable } from "langsmith/traceable";
import { streamLoop, loadThreadState, type ChatEvent } from "./chat-agent";

export function chatStreamResponse(
  userId: string,
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
        // "TypeError: fetch failed" hides the real reason in err.cause and, for
        // undici, in an AggregateError's .errors[]. Walk both, and surface the
        // failing address:port (ECONNREFUSED 127.0.0.1:8288 etc.) — that names
        // exactly which call is broken.
        const bits: string[] = [];
        const seen = new Set<unknown>();
        const visit = (e: unknown, depth = 0) => {
          if (!e || seen.has(e) || depth > 6) return;
          seen.add(e);
          const o = e as {
            message?: string; code?: string; syscall?: string;
            address?: string; port?: number; cause?: unknown; errors?: unknown[];
          };
          const loc = o.address ? ` ${o.address}${o.port ? ":" + o.port : ""}` : "";
          if (o.code || o.syscall || loc) {
            bits.push(`${o.code ?? ""}${o.syscall ? " " + o.syscall : ""}${loc}`.trim());
          } else if (o.message) {
            bits.push(o.message);
          }
          if (Array.isArray(o.errors)) o.errors.forEach((x) => visit(x, depth + 1));
          visit(o.cause, depth + 1);
        };
        visit(err);
        const base = err instanceof Error ? err.message : "chat failed";
        const detail = [...new Set(bits)].filter(Boolean).join("; ");
        const message = detail ? `${base} — ${detail}` : base;
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
