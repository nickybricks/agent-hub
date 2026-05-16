/**
 * Phase 3.5 agentic-chat loop. Read-only tools auto-run inside one request;
 * mutating tools pause the loop with a persisted pending tool_call that the
 * user must confirm via /chat/confirm before execute fires.
 *
 * Provider: the configured digest provider when it's anthropic/openai
 * (reliable tool-calling), otherwise transparent Anthropic fallback.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { createLLM, type LLMConfig } from "@/agent/summarize";
import { withGuardrail } from "./prompt-safety";
import { TOOL_SPECS, getToolSpec, runReadTool, previewMutation } from "./chat-tools";
import * as sq from "./chat-db";
import * as pg from "./chat-db-pg";
import type { ChatMessage } from "./chat-db";
import { writeMemory } from "./analyzer-db";
import { writeMemoryPg } from "./analyzer-db-pg";

const MAX_ITERS = 6;
const ANTHROPIC_FALLBACK_MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You are the user's email mailbox agent. You can both answer questions about the mailbox and act on it through tools.

Rules:
- Explain your reasoning before calling any tool. When proposing changes, walk through what you found and why.
- Read-only tools run automatically. Mutating tools require the user's explicit confirmation — the UI shows an Apply/Cancel card after you request one; never assume it succeeded until you see a tool result.
- Request at most ONE mutating action at a time. After it resolves, continue.
- Never invent ids, folder paths, rule ids, or sender addresses. If you need one, look it up with a read tool first.
- When uncertain, ask a clarifying question instead of guessing.
- Cite memories inline as [m<id>] when you rely on one.
- Be concise and answer in the user's language.`;

// ── dual-path store ──────────────────────────────────────────────────────────

function listMessages(userId: string | null, threadId: number) {
  return userId ? pg.listMessagesPg(userId, threadId) : Promise.resolve(sq.listMessages(threadId));
}
function appendMessage(userId: string | null, m: Parameters<typeof sq.appendMessage>[0]) {
  return userId ? pg.appendMessagePg(userId, m) : Promise.resolve(sq.appendMessage(m));
}
function createToolCall(userId: string | null, c: Parameters<typeof sq.createToolCall>[0]) {
  return userId ? pg.createToolCallPg(userId, c) : Promise.resolve(sq.createToolCall(c));
}
function touchThread(userId: string | null, id: number) {
  return userId ? pg.touchThreadPg(userId, id) : Promise.resolve(sq.touchThread(id));
}
export function getToolCall(userId: string | null, id: number) {
  return userId ? pg.getToolCallPg(userId, id) : Promise.resolve(sq.getToolCall(id));
}
export function finishToolCall(
  userId: string | null,
  id: number,
  status: "executed" | "cancelled" | "failed",
  result?: string | null,
) {
  return userId
    ? pg.finishToolCallPg(userId, id, status, result)
    : Promise.resolve(sq.finishToolCall(id, status, result));
}
export function persistMemory(
  userId: string | null,
  content: string,
  key: string | null,
) {
  const memo = { kind: "user_pref" as const, key, content, source: "user_decision" as const };
  return userId ? writeMemoryPg(userId, memo) : Promise.resolve(writeMemory(memo));
}

// ── LLM config ───────────────────────────────────────────────────────────────

function resolveChatLLMConfig(): LLMConfig {
  const cfg = JSON.parse(readFileSync(join(process.cwd(), "data", "config.json"), "utf-8"));
  const agent = cfg.agents?.find((a: { id: string }) => a.id === "newsletter-summarizer");
  if (!agent?.settings?.llm) throw new Error("No LLM config in data/config.json");
  const llm = { ...agent.settings.llm } as LLMConfig;
  if (llm.provider !== "anthropic" && llm.provider !== "openai") {
    // Ollama / Google: not reliable for this tool-calling UX — fall back to Claude.
    llm.provider = "anthropic";
    llm.model = ANTHROPIC_FALLBACK_MODEL;
  }
  return { ...llm, systemPrompt: withGuardrail(SYSTEM_PROMPT) };
}

const OPENAI_TOOLS = TOOL_SPECS.map((s) => ({
  type: "function" as const,
  function: { name: s.name, description: s.description, parameters: s.schema },
}));

// ── transcript → LangChain messages ──────────────────────────────────────────

function toLangChain(history: ChatMessage[]): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (const m of history) {
    if (m.role === "user") out.push(new HumanMessage(m.content ?? ""));
    else if (m.role === "assistant") out.push(new AIMessage(m.content ?? ""));
    else if (m.role === "tool")
      // Tool results from earlier turns are replayed as plain context (we do not
      // reconstruct the raw tool_call protocol across request boundaries).
      out.push(new HumanMessage(`[tool ${m.tool_name ?? "?"} result] ${m.content ?? ""}`));
  }
  return out;
}

export interface PendingToolCall {
  id: number;
  tool_name: string;
  input: Record<string, unknown>;
  summary: string;
}

export interface TurnResult {
  assistantText: string;
  pending: PendingToolCall | null;
}

/**
 * Rebuild context from the persisted transcript and drive the model until it
 * produces a final answer or requests a mutating action (which pauses for
 * confirmation). Caller must have already persisted the triggering message.
 */
export async function runLoop(userId: string | null, threadId: number): Promise<TurnResult> {
  const config = resolveChatLLMConfig();
  const llm = createLLM(config);
  if (!llm.bindTools) throw new Error(`provider ${config.provider} does not support tool calling`);
  const model = llm.bindTools(OPENAI_TOOLS as never);

  const history = await listMessages(userId, threadId);
  const msgs: BaseMessage[] = [new SystemMessage(config.systemPrompt), ...toLangChain(history)];

  let lastText = "";

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const res = (await model.invoke(msgs, {
      tags: ["mail-analyzer", "chat", `provider:${config.provider}`],
    })) as AIMessage;

    const text =
      typeof res.content === "string"
        ? res.content
        : res.content.map((c) => ("text" in c ? c.text : "")).join("");
    const toolCalls = res.tool_calls ?? [];

    if (toolCalls.length === 0) {
      const answer = text.trim() || "(no response)";
      await appendMessage(userId, { thread_id: threadId, role: "assistant", content: answer });
      await touchThread(userId, threadId);
      return { assistantText: answer, pending: null };
    }

    // A mutating request pauses the loop for user confirmation.
    const mutate = toolCalls.find((tc) => getToolSpec(tc.name)?.kind === "mutate");
    if (mutate) {
      const preview = await previewMutation(userId, mutate.name, mutate.args);
      const reasoning = text.trim();
      await appendMessage(userId, {
        thread_id: threadId,
        role: "assistant",
        content: reasoning || `I'd like to run \`${mutate.name}\`.`,
      });
      const tcId = await createToolCall(userId, {
        thread_id: threadId,
        tool_name: mutate.name,
        tool_input: JSON.stringify(mutate.args),
        preview: JSON.stringify(preview),
        reasoning: reasoning || null,
      });
      await touchThread(userId, threadId);
      return {
        assistantText: reasoning,
        pending: { id: tcId, tool_name: mutate.name, input: mutate.args, summary: preview.summary },
      };
    }

    // Read-only calls: execute all, feed results back, keep looping.
    msgs.push(res);
    for (const tc of toolCalls) {
      let result: unknown;
      try {
        result = await runReadTool(userId, tc.name, tc.args);
      } catch (e) {
        result = { error: e instanceof Error ? e.message : String(e) };
      }
      const json = JSON.stringify(result);
      msgs.push(new ToolMessage({ content: json, tool_call_id: tc.id ?? tc.name }));
      await appendMessage(userId, {
        thread_id: threadId,
        role: "tool",
        content: json.slice(0, 8000),
        tool_name: tc.name,
      });
    }
    lastText = text;
  }

  const fallback =
    lastText.trim() || "I hit the tool-call limit for this turn. Ask me to continue.";
  await appendMessage(userId, { thread_id: threadId, role: "assistant", content: fallback });
  await touchThread(userId, threadId);
  return { assistantText: fallback, pending: null };
}
