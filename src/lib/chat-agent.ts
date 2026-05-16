/**
 * Phase 3.5 agentic-chat loop (streaming). Read-only tools auto-run inside one
 * request; mutating tools pause the loop with a persisted pending tool_call the
 * user must confirm via /chat/confirm before execute fires.
 *
 * Streams token + reasoning + tool events (ac6). When the configured provider
 * is Anthropic, Claude extended-thinking is enabled and surfaced as `thinking`
 * events (ac1). LangSmith spans wrap the turn + each tool (ac7).
 *
 * Provider: the configured digest provider when it's anthropic/openai
 * (reliable tool-calling), otherwise transparent Anthropic fallback.
 */

import { readFileSync } from "fs";
import { join } from "path";
import {
  AIMessageChunk,
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";
import { traceable } from "langsmith/traceable";
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
const THINKING_BUDGET_TOKENS = 2048;
const THINKING_MAX_TOKENS = 4096;

const SYSTEM_PROMPT = `You are the user's email mailbox agent. You can both answer questions about the mailbox and act on it through tools.

Rules:
- Explain your reasoning before calling any tool. When proposing changes, walk through what you found and why.
- Read-only tools run automatically. Mutating tools require the user's explicit confirmation — the UI shows an Apply/Cancel card after you request one; never assume it succeeded until you see a tool result.
- Request at most ONE mutating action at a time. After it resolves, continue.
- Never invent ids, folder paths, rule ids, or sender addresses. If you need one, look it up with a read tool first.
- When uncertain, ask a clarifying question instead of guessing. When the answer is a discrete choice, call \`ask_user\` with 2–4 short options instead of a free-form question.
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
export async function loadThreadState(userId: string | null, threadId: number) {
  const messages = await listMessages(userId, threadId);
  const pendingRow = userId
    ? await pg.getPendingToolCallPg(userId, threadId)
    : sq.getPendingToolCall(threadId);
  const pending = pendingRow
    ? {
        id: pendingRow.id,
        tool_name: pendingRow.tool_name,
        input: JSON.parse(pendingRow.tool_input) as Record<string, unknown>,
        summary: pendingRow.preview ? JSON.parse(pendingRow.preview).summary : pendingRow.tool_name,
      }
    : null;
  return { messages, pending };
}

export function persistMemory(userId: string | null, content: string, key: string | null) {
  const memo = { kind: "user_pref" as const, key, content, source: "user_decision" as const };
  return userId ? writeMemoryPg(userId, memo) : Promise.resolve(writeMemory(memo));
}

// ── LLM config + model ───────────────────────────────────────────────────────

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

interface BoundModel {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stream: (msgs: BaseMessage[], opts: Record<string, unknown>) => Promise<AsyncIterable<any>>;
  thinking: boolean;
}

/** Build a tool-bound chat model; enable Claude extended thinking for Anthropic. */
function buildModel(config: LLMConfig): BoundModel {
  if (config.provider === "anthropic") {
    const apiKey =
      process.env.ANTHROPIC_API_KEY || config.apiKeys?.anthropic || config.apiKey;
    const model = new ChatAnthropic({
      apiKey,
      model: config.model,
      maxTokens: THINKING_MAX_TOKENS,
      thinking: { type: "enabled", budget_tokens: THINKING_BUDGET_TOKENS },
    }).bindTools(OPENAI_TOOLS as never);
    return { stream: (m, o) => model.stream(m, o), thinking: true };
  }
  const llm = createLLM(config);
  if (!llm.bindTools) throw new Error(`provider ${config.provider} does not support tool calling`);
  const bound = llm.bindTools(OPENAI_TOOLS as never);
  return { stream: (m, o) => bound.stream(m, o), thinking: false };
}

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

// Extract text + reasoning deltas from a streamed chunk (provider-agnostic).
function splitDelta(content: unknown): { text: string; thinking: string } {
  if (typeof content === "string") return { text: content, thinking: "" };
  if (!Array.isArray(content)) return { text: "", thinking: "" };
  let text = "";
  let thinking = "";
  for (const item of content as Array<Record<string, unknown>>) {
    const t = String(item.type ?? "");
    if (t === "text" || t === "text_delta") text += String(item.text ?? "");
    else if (t.includes("thinking") || t.includes("reasoning"))
      thinking += String(item.thinking ?? item.reasoning ?? item.text ?? "");
  }
  return { text, thinking };
}

export interface PendingToolCall {
  id: number;
  tool_name: string;
  input: Record<string, unknown>;
  summary: string;
}

export type ChatEvent =
  | { type: "thinking"; delta: string }
  | { type: "token"; delta: string }
  | { type: "tool"; name: string; phase: "running" | "done"; summary?: string }
  | { type: "pending"; pending: PendingToolCall }
  | { type: "ask"; question: string; options: string[] }
  | { type: "final"; assistantText: string };

/**
 * Rebuild context from the persisted transcript and drive the model, yielding
 * stream events until a final answer or a mutating action that pauses for
 * confirmation. Caller must have already persisted the triggering message.
 */
export async function* streamLoop(
  userId: string | null,
  threadId: number,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  const config = resolveChatLLMConfig();
  const model = buildModel(config);

  const history = await listMessages(userId, threadId);
  const msgs: BaseMessage[] = [new SystemMessage(config.systemPrompt), ...toLangChain(history)];
  const callOpts = { signal, tags: ["mail-analyzer", "chat", `provider:${config.provider}`] };

  let lastText = "";

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    let gathered: AIMessageChunk | undefined;
    const stream = await model.stream(msgs, callOpts);
    for await (const chunk of stream) {
      if (signal?.aborted) break;
      gathered = gathered === undefined ? chunk : gathered.concat(chunk);
      const { text, thinking } = splitDelta(chunk.content);
      if (thinking) yield { type: "thinking", delta: thinking };
      if (text) yield { type: "token", delta: text };
    }
    if (!gathered) break;

    const text =
      typeof gathered.content === "string"
        ? gathered.content
        : splitDelta(gathered.content).text;
    const toolCalls = gathered.tool_calls ?? [];

    if (toolCalls.length === 0) {
      const answer = text.trim() || "(no response)";
      await appendMessage(userId, { thread_id: threadId, role: "assistant", content: answer });
      await touchThread(userId, threadId);
      yield { type: "final", assistantText: answer };
      return;
    }

    // A clarifying question ends the turn; the user's reply is the next turn.
    const ask = toolCalls.find((tc) => getToolSpec(tc.name)?.kind === "ask");
    if (ask) {
      const question = String(ask.args.question ?? "").trim();
      const options = Array.isArray(ask.args.options)
        ? (ask.args.options as unknown[]).map(String).filter(Boolean).slice(0, 4)
        : [];
      const reasoning = text.trim();
      const content = reasoning && reasoning !== question ? `${reasoning}\n\n${question}` : question;
      await appendMessage(userId, { thread_id: threadId, role: "assistant", content });
      await touchThread(userId, threadId);
      yield { type: "ask", question, options };
      return;
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
      yield {
        type: "pending",
        pending: { id: tcId, tool_name: mutate.name, input: mutate.args, summary: preview.summary },
      };
      return;
    }

    // Read-only calls: execute all (each its own trace span), feed back, loop.
    msgs.push(gathered);
    for (const tc of toolCalls) {
      yield { type: "tool", name: tc.name, phase: "running" };
      let result: unknown;
      try {
        const runTool = traceable(
          async () => runReadTool(userId, tc.name, tc.args),
          { name: `tool.${tc.name}`, run_type: "tool", metadata: { args: tc.args } },
        );
        result = await runTool();
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
      yield { type: "tool", name: tc.name, phase: "done", summary: json.slice(0, 200) };
    }
    lastText = text;

    if (signal?.aborted) break;
  }

  const fallback =
    lastText.trim() || "I hit the tool-call limit for this turn. Ask me to continue.";
  await appendMessage(userId, { thread_id: threadId, role: "assistant", content: fallback });
  await touchThread(userId, threadId);
  yield { type: "final", assistantText: fallback };
}
