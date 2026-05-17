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
import { writeMemoryPg, listMemoriesPg } from "./analyzer-db-pg";
import { getMailCredentials } from "./credentials";
import { runOnboardingPipeline } from "./onboarding";

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
- When you need ANY clarification, you MUST call the \`ask_user\` tool with the question and 2–4 short candidate answers — never ask a clarifying question as plain assistant text. The user can still type a free answer instead of clicking one. Only skip \`ask_user\` if there are genuinely no plausible candidate answers to offer.
- Cite memories inline as [m<id>] when you rely on one.
- Be concise and answer in the user's language.`;

const ONBOARDING_SYSTEM_PROMPT = `You are onboarding a brand-new user of their email mailbox agent. Be warm, brief, and conversational — one short message at a time, never a wall of text. Drive the flow; the user should mostly just answer.

The onboarding has a fixed order. A STATE line below tells you what's already done — always continue from the first incomplete step, never repeat a finished one:

1. Connect mailbox. If the mailbox is NOT connected, call \`connect_mailbox\` (shows an in-chat connect card) and stop. Do nothing else until connected.
2. Questionnaire. Once connected, ask these five questions ONE AT A TIME, in order. For the first three use \`ask_user\` with 2–4 short options; the last two are open free-text (ask in plain text):
   a. mailbox_type — "What kind of mailbox is this?" (e.g. Personal, Work, Mixed)
   b. folder_style — "How do you like things organised?" (e.g. A few broad folders, Many specific folders, Minimal — mostly search)
   c. cleanup_aggressiveness — "How aggressively should I tidy up?" (e.g. Conservative, Balanced, Aggressive)
   d. occupation — "What do you do? A sentence is plenty."
   e. sacred — "Anything I should never touch or move? (people, folders, topics)"
   After EACH answer, immediately call \`save_onboarding_answer\` with the matching key and the user's answer. Then ask the next question.
3. Pipeline. When all five answers are saved, call \`run_pipeline\`. It scans + classifies the mailbox, streams progress, and presents a draft persona card. Stop after calling it.
4. After the user confirms their persona, the system generates folder proposals. Tell them their profile is set and folder proposals are being prepared on the Proposals tab, and that they can ask you to walk through them.

Rules:
- Never ask a question without \`ask_user\` when discrete choices exist.
- Never invent that a step is done — trust the STATE line.
- Do not call any non-onboarding tools during onboarding.
- Answer in the user's language. Keep every message to 1–3 sentences.`;

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

/**
 * Onboarding is complete once a `user_profile` memory exists. Local single-user
 * dev (userId null) has no onboarding. Returns connection + answer state used to
 * drive the onboarding system prompt.
 */
export async function onboardingState(userId: string | null): Promise<{
  active: boolean;
  connected: boolean;
  answered: string[];
}> {
  if (!userId) return { active: false, connected: true, answered: [] };
  const profile = await listMemoriesPg(userId, { kind: "user_profile", limit: 1 });
  if (profile.length > 0) return { active: false, connected: true, answered: [] };

  const prefs = await listMemoriesPg(userId, { kind: "user_pref", limit: 50 });
  const answered = prefs
    .map((p) => p.key ?? "")
    .filter((k) => k.startsWith("onboarding:"))
    .map((k) => k.replace("onboarding:", ""));

  let connected = false;
  try {
    const c = await getMailCredentials(userId);
    connected =
      !!c.imap?.host && !!c.imap?.user && !!c.imap?.password
        ? true
        : !!c.gmail?.refreshToken || !!c.outlook?.refreshToken;
  } catch {
    connected = false;
  }
  return { active: true, connected, answered };
}

export function persistMemory(userId: string | null, content: string, key: string | null) {
  const memo = { kind: "user_pref" as const, key, content, source: "user_decision" as const };
  return userId ? writeMemoryPg(userId, memo) : Promise.resolve(writeMemory(memo));
}

// ── LLM config + model ───────────────────────────────────────────────────────

// Cheap model for trivial factual turns; smart model for anything agentic.
const CHEAP_MODEL = { provider: "openai" as const, model: "gpt-4o-mini" };
const SMART_MODEL = { provider: "anthropic" as const, model: "claude-sonnet-4-6" };

const CLASSIFIER_PROMPT = `You route a user's message to an email-mailbox assistant.

Answer with exactly one word — "simple" or "complex":
- simple: a single factual lookup the assistant can answer in one step (counts, lists, "who/when/how many", show me X).
- complex: anything needing a decision, judgment, planning, multi-step reasoning, mailbox changes, or a clarifying question.

If you are unsure, answer "complex".`;

/** Cheap, fast model for the routing decision itself (no tools, no thinking). */
function buildClassifier(base: LLMConfig): ReturnType<typeof createLLM> | null {
  const hasOpenAI = !!(process.env.OPENAI_API_KEY || base.apiKeys?.openai);
  const hasAnthropic = !!(process.env.ANTHROPIC_API_KEY || base.apiKeys?.anthropic);
  const cfg: LLMConfig | null = hasOpenAI
    ? { ...base, provider: "openai", model: "gpt-4o-mini", systemPrompt: "" }
    : hasAnthropic
      ? { ...base, provider: "anthropic", model: ANTHROPIC_FALLBACK_MODEL, systemPrompt: "" }
      : null;
  return cfg ? createLLM(cfg) : null;
}

/**
 * Per-turn complexity decision, made by a cheap LLM (not keyword matching).
 * Structural shortcut only: confirm/resume turns carry no new user text (the
 * "message" is a tool result), so they're inherently agentic → complex without
 * spending a classifier call. Any classifier failure → complex (safe default,
 * preserves ask_user / tool reliability).
 */
async function classifyComplexity(
  history: ChatMessage[],
  base: LLMConfig,
): Promise<"simple" | "complex"> {
  if (history.length === 0) return "complex";
  const last = history[history.length - 1];
  if (last.role !== "user") return "complex";
  const text = (last.content ?? "").trim();
  if (!text) return "complex";

  const clf = buildClassifier(base);
  if (!clf) return "complex";
  try {
    const res = await clf.invoke(
      [new SystemMessage(CLASSIFIER_PROMPT), new HumanMessage(text)],
      { tags: ["mail-analyzer", "chat", "router"] },
    );
    const out = (typeof res.content === "string" ? res.content : "").toLowerCase();
    return out.includes("simple") && !out.includes("complex") ? "simple" : "complex";
  } catch {
    return "complex";
  }
}

function pickModel(
  complexity: "simple" | "complex",
  hasOpenAI: boolean,
  hasAnthropic: boolean,
): { provider: "openai" | "anthropic"; model: string } {
  if (complexity === "complex") {
    if (hasAnthropic) return SMART_MODEL;
    if (hasOpenAI) return CHEAP_MODEL; // degraded but functional
    return SMART_MODEL; // key resolver will throw a clear error
  }
  if (hasOpenAI) return CHEAP_MODEL;
  if (hasAnthropic) return { provider: "anthropic", model: ANTHROPIC_FALLBACK_MODEL };
  return CHEAP_MODEL;
}

/**
 * Resolve the chat model for this turn. Fully provider-managed: the user
 * never sees or controls the model or system prompt. Cheap model for trivial
 * questions, smart model for agentic ones — automatic, to save cost.
 */
// Multi-tenant / Vercel has no data/config.json. The router overrides
// provider/model per turn and key resolution is env-first, so an empty
// shell base is sufficient there.
function envChatLLMBase(): LLMConfig {
  return { provider: "anthropic", model: ANTHROPIC_FALLBACK_MODEL, systemPrompt: "" };
}

async function resolveChatLLMConfig(history: ChatMessage[]): Promise<LLMConfig> {
  let llm: LLMConfig;
  try {
    const cfg = JSON.parse(readFileSync(join(process.cwd(), "data", "config.json"), "utf-8"));
    const agent = cfg.agents?.find((a: { id: string }) => a.id === "newsletter-summarizer");
    if (!agent?.settings?.llm) throw new Error("No LLM config in data/config.json");
    llm = { ...agent.settings.llm } as LLMConfig;
  } catch {
    llm = envChatLLMBase();
  }

  const hasAnthropic = !!(process.env.ANTHROPIC_API_KEY || llm.apiKeys?.anthropic);
  const hasOpenAI = !!(process.env.OPENAI_API_KEY || llm.apiKeys?.openai);
  const complexity = await classifyComplexity(history, llm);
  const pick = pickModel(complexity, hasOpenAI, hasAnthropic);
  llm.provider = pick.provider;
  llm.model = pick.model;

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
  | { type: "connect" }
  | { type: "progress"; label: string }
  | { type: "persona"; text: string }
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
  const history = await listMessages(userId, threadId);
  const config = await resolveChatLLMConfig(history);
  const model = buildModel(config);

  // Onboarding branch: swap the system prompt and inject a STATE line so the
  // model always resumes from the first incomplete step.
  const onb = await onboardingState(userId);
  if (onb.active) {
    const state = `STATE — mailbox connected: ${onb.connected ? "yes" : "NO"}; questionnaire answers saved: ${
      onb.answered.length ? onb.answered.join(", ") : "none"
    }.`;
    config.systemPrompt = withGuardrail(`${ONBOARDING_SYSTEM_PROMPT}\n\n${state}`);
  }

  const msgs: BaseMessage[] = [new SystemMessage(config.systemPrompt), ...toLangChain(history)];
  const callOpts = {
    signal,
    tags: ["mail-analyzer", "chat", `provider:${config.provider}`, `model:${config.model}`],
  };

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

    // Onboarding actions: connect card or the scan/classify/persona pipeline.
    const onboard = toolCalls.find((tc) => getToolSpec(tc.name)?.kind === "onboard");
    if (onboard) {
      const reasoning = text.trim();
      if (reasoning) {
        await appendMessage(userId, { thread_id: threadId, role: "assistant", content: reasoning });
      }

      if (onboard.name === "connect_mailbox") {
        await appendMessage(userId, {
          thread_id: threadId,
          role: "tool",
          tool_name: "connect_mailbox",
          content: "Showed the connect-mailbox card; waiting for the user to connect.",
        });
        await touchThread(userId, threadId);
        yield { type: "connect" };
        return;
      }

      // run_pipeline: scan + classify with streamed progress, then a persona draft.
      if (!userId) {
        yield { type: "final", assistantText: "Onboarding is only available for signed-in accounts." };
        return;
      }
      try {
        let persona = "";
        for await (const ev of runOnboardingPipeline(userId)) {
          if (signal?.aborted) break;
          if (ev.kind === "progress") yield { type: "progress", label: ev.label };
          else persona = ev.text;
        }
        await appendMessage(userId, {
          thread_id: threadId,
          role: "tool",
          tool_name: "run_pipeline",
          content: "Scan + classify complete. Draft persona prepared.",
        });
        await touchThread(userId, threadId);
        yield { type: "persona", text: persona };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await appendMessage(userId, {
          thread_id: threadId,
          role: "assistant",
          content: `I hit a problem running the scan: ${msg}. You can ask me to try again.`,
        });
        await touchThread(userId, threadId);
        yield { type: "final", assistantText: `Scan failed: ${msg}` };
      }
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
