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
import {
  TOOL_SPECS,
  getToolSpec,
  runReadTool,
  previewMutation,
  normalizeAskOptions,
  type AskOption,
} from "./chat-tools";
import * as pg from "./chat-db-pg";
import type { ChatMessage } from "./chat-db";
import { writeMemoryPg, listMemoriesPg } from "./analyzer-db-pg";
import { getMailCredentials } from "./credentials";

const MAX_ITERS = 6;
// Single-chat model: one ever-growing thread. Replay only the last
// RECENT_TURNS messages verbatim; once unsummarized history exceeds
// SUMMARIZE_WHEN, fold everything older than the recent window into a rolling
// summary memory so per-turn context stays bounded.
const RECENT_TURNS = 24;
const SUMMARIZE_WHEN = 40;
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
- When the user volunteers a durable personal fact (their name, what to call them, the name they've given you, their occupation, a sentence of personal context), call \`remember_about_user\` once with a concise note. Never interrogate for these facts — only capture what the user offers. Don't re-ask anything already in the soul-context below.
- Cite memories inline as [m<id>] when you rely on one.
- Be concise and answer in the user's language.`;

const ONBOARDING_SYSTEM_PROMPT = `You are onboarding a brand-new user of their email mailbox agent. Be warm, calm, conversational — one short message at a time (1–3 sentences), never pushy, never a wall of text. The user should mostly just answer.

A STATE line below tells you exactly what's already done — always continue from the first incomplete step. Never repeat a step the STATE says is done.

Fixed order:

1. **Connect mailbox.** If NOT connected, call \`connect_mailbox\` and stop. Do nothing else until it's connected.

2. **Warm intro + name.** Once connected, if no \`soul\` memory yet, introduce yourself in one short sentence and ask: *"What should I call you?"* — free text, NOT an \`ask_user\` (names aren't a choice). When they reply, immediately call \`remember_about_user\` with their preferred name (one concise note). Then, in the same next message, gently offer: *"Want to give me a name too, or shall I just stay 'your mailbox agent'? Either's good."* — also free text. If they name you, call \`remember_about_user\` with that too; if they decline, just continue — never push.

3. **Questionnaire — three button questions.** Ask these one at a time, in order, ALWAYS via \`ask_user\`. Each option must carry a one-line \`hint\` and you should mark one option \`recommended: true\` with a hint that starts with the reason:
   a. \`mailbox_type\` — "What kind of mailbox is this?" e.g. Personal / Work / Mixed (recommend Mixed for first runs: *"covers both — you can sharpen later"*). \`save_onboarding_answer key: mailbox_type\`.
   b. \`folder_style\` — "How do you like things organised?" e.g. A few broad folders / Many specific folders / Minimal — mostly search (recommend "A few broad folders": *"easier to keep tidy than many tiny ones"*). \`save_onboarding_answer key: folder_style\`.
   c. \`cleanup_aggressiveness\` — "How aggressively should I tidy up?" e.g. Conservative / Balanced / Aggressive (recommend Balanced: *"moves obvious stuff, asks before anything fuzzy"*). \`save_onboarding_answer key: cleanup_aggressiveness\`.

4. **Sacred — generic buttons.** \`ask_user\` for \`sacred\` with generic options + hints, e.g. *"Nothing — you decide"* (recommend: *"start clean; we'll add exceptions in chat once I know your mailbox"*), *"My personal & family contacts"*, *"Specific folders — I'll name them"*. Then \`save_onboarding_answer key: sacred\`.

5. **Optional personal context.** ONE gentle prompt, explicitly skippable. Use \`ask_user\` with the question *"Last thing — want to tell me a bit about what you do, or your world, so I read your senders better?"* and exactly ONE option: \`label: "Skip — let's just start"\`, \`hint: "totally fine; we can fill this in later through chat"\`. The user can click Skip OR type a free answer. If they share something, call \`remember_about_user\` with a concise note. If they skip, acknowledge briefly and move on. Never re-ask.

6. **Pipeline.** Call \`run_pipeline\`. It scans + classifies the mailbox, streams progress, and presents a draft persona card. Stop after calling it.

7. After persona confirmation, the system generates folder proposals. Tell them their profile is set and folder proposals are being prepared on the Proposals tab; they can ask you to walk through them.

Tone rules:
- Calm, never pushy. Always give a graceful opt-out for anything personal.
- One question at a time. 1–3 sentences per message.
- Never ask a clarifying question as plain text when discrete choices exist — use \`ask_user\`.
- Never invent that a step is done — trust the STATE line.
- Do not call any non-onboarding tools during onboarding.
- Answer in the user's language.`;

// ── persistence wrappers ─────────────────────────────────────────────────────

const listMessages = pg.listMessagesPg;
const appendMessage = pg.appendMessagePg;
const createToolCall = pg.createToolCallPg;
const touchThread = pg.touchThreadPg;
export const getToolCall = pg.getToolCallPg;
export const finishToolCall = pg.finishToolCallPg;
const savePendingAsk = pg.savePendingAskPg;
const clearPendingAsks = pg.clearPendingAsksPg;
export const getPendingAsk = pg.getPendingAskPg;

export async function loadThreadState(userId: string, threadId: number) {
  const messages = await listMessages(userId, threadId);
  const pendingRow = await pg.getPendingToolCallPg(userId, threadId);
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
 * Onboarding is complete once a `user_profile` memory exists. Returns
 * connection + answer state used to drive the onboarding system prompt.
 */
export async function onboardingState(userId: string): Promise<{
  active: boolean;
  connected: boolean;
  answered: string[];
  hasSoul: boolean;
}> {
  const profile = await listMemoriesPg(userId, { kind: "user_profile", limit: 1 });
  if (profile.length > 0) return { active: false, connected: true, answered: [], hasSoul: true };

  const prefs = await listMemoriesPg(userId, { kind: "user_pref", limit: 50 });
  const answered = prefs
    .map((p) => p.key ?? "")
    .filter((k) => k.startsWith("onboarding:"))
    .map((k) => k.replace("onboarding:", ""));

  const soul = await listMemoriesPg(userId, { kind: "soul", limit: 1 });
  const hasSoul = soul.length > 0;

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
  return { active: true, connected, answered, hasSoul };
}

export function persistMemory(userId: string, content: string, key: string | null) {
  return writeMemoryPg(userId, {
    kind: "user_pref",
    key,
    content,
    source: "user_decision",
  });
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

// ── rolling conversation summary ─────────────────────────────────────────────

const SUMMARY_PROMPT = `You maintain a running summary of a long user↔assistant conversation about the user's email mailbox.
Fold the PRIOR SUMMARY and the OLDER MESSAGES below into one updated summary.
Preserve durable facts, the user's stated preferences and decisions, anything still open or promised, and important context the assistant will need later. Drop pleasantries and resolved chit-chat.
Write tight prose (no headings, no bullet lists), at most ~200 words. Output only the summary.`;

interface SummaryState {
  through: number; // highest message id already folded into `text`
  text: string;
}

function readSummary(userId: string, threadId: number): Promise<SummaryState> {
  const key = `chat_summary:${threadId}`;
  return listMemoriesPg(userId, { kind: "system", key, limit: 1 }).then((r) => {
    try {
      const o = JSON.parse(r[0]?.content ?? "");
      return { through: Number(o.through) || 0, text: String(o.text ?? "") };
    } catch {
      return { through: 0, text: "" };
    }
  });
}

function saveSummary(userId: string, threadId: number, s: SummaryState) {
  return writeMemoryPg(userId, {
    kind: "system",
    key: `chat_summary:${threadId}`,
    content: JSON.stringify(s),
    source: "self",
  });
}

/**
 * Bound per-turn context for the single ever-growing chat: replay only the most
 * recent messages verbatim; everything older is folded into a rolling summary
 * memory. Returns the recent slice + the summary text to prepend as context.
 */
async function rollUpHistory(
  userId: string,
  threadId: number,
  history: ChatMessage[],
  base: LLMConfig,
): Promise<{ recent: ChatMessage[]; summaryText: string }> {
  const prior = await readSummary(userId, threadId);
  const unsummarized = history.filter((m) => m.id > prior.through);

  if (unsummarized.length <= SUMMARIZE_WHEN) {
    return { recent: unsummarized, summaryText: prior.text };
  }

  const older = unsummarized.slice(0, unsummarized.length - RECENT_TURNS);
  const recent = unsummarized.slice(-RECENT_TURNS);

  const clf = buildClassifier(base);
  if (!clf) {
    // No model available to summarize — still cap replay so context stays
    // bounded; older turns are dropped (rare: no API keys configured at all).
    return { recent, summaryText: prior.text };
  }

  const rendered = older
    .map((m) => `${m.role}${m.tool_name ? `(${m.tool_name})` : ""}: ${(m.content ?? "").slice(0, 1500)}`)
    .join("\n");
  const payload = `PRIOR SUMMARY:\n${prior.text || "(none)"}\n\nOLDER MESSAGES:\n${rendered}`;

  let text = prior.text;
  try {
    const res = await clf.invoke(
      [new SystemMessage(SUMMARY_PROMPT), new HumanMessage(payload)],
      { tags: ["mail-analyzer", "chat", "summary"] },
    );
    const out = typeof res.content === "string" ? res.content : String(res.content);
    if (out.trim()) {
      text = out.trim();
      const through = older[older.length - 1].id;
      await saveSummary(userId, threadId, { through, text });
    }
  } catch {
    // Summary call failed — fall back to the prior summary + capped window.
  }
  return { recent, summaryText: text };
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
  | { type: "ask"; question: string; options: AskOption[] }
  | { type: "connect" }
  | { type: "pipeline" }
  | { type: "final"; assistantText: string };

/**
 * Rebuild context from the persisted transcript and drive the model, yielding
 * stream events until a final answer or a mutating action that pauses for
 * confirmation. Caller must have already persisted the triggering message.
 */
export async function* streamLoop(
  userId: string,
  threadId: number,
  signal?: AbortSignal,
): AsyncGenerator<ChatEvent> {
  // A new turn means any previously-pending ask is now being answered
  // (button click or a typed free answer) — retire it.
  await clearPendingAsks(userId, threadId);
  const history = await listMessages(userId, threadId);
  const config = await resolveChatLLMConfig(history);
  const model = buildModel(config);

  // Onboarding branch: swap the system prompt and inject a STATE line so the
  // model always resumes from the first incomplete step.
  const onb = await onboardingState(userId);
  if (onb.active) {
    const state = `STATE — mailbox connected: ${onb.connected ? "yes" : "NO"}; soul memory (name + any volunteered context): ${
      onb.hasSoul ? "saved" : "NOT yet"
    }; questionnaire answers saved: ${onb.answered.length ? onb.answered.join(", ") : "none"}.`;
    config.systemPrompt = withGuardrail(`${ONBOARDING_SYSTEM_PROMPT}\n\n${state}`);
  }

  const soulMems = await listMemoriesPg(userId, { kind: "soul", limit: 1 });
  const soulText = soulMems[0]?.content?.trim() ?? "";

  const { recent, summaryText } = await rollUpHistory(userId, threadId, history, config);
  // Anthropic only accepts a single `system` payload, so consolidate the base
  // prompt + soul context + rolling summary into ONE SystemMessage. Multiple
  // consecutive SystemMessages trigger
  // "System messages are only permitted as the first passed message".
  const systemSections = [config.systemPrompt];
  if (soulText) {
    systemSections.push(
      `What you know about this user (use their name and yours if they've given one; don't re-ask any of this):\n${soulText}`,
    );
  }
  if (summaryText) {
    systemSections.push(
      `Summary of earlier conversation (context — not repeated verbatim below):\n${summaryText}`,
    );
  }
  const msgs: BaseMessage[] = [
    new SystemMessage(systemSections.join("\n\n---\n\n")),
    ...toLangChain(recent),
  ];
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
      const options = normalizeAskOptions(ask.args.options);
      const reasoning = text.trim();
      const content = reasoning && reasoning !== question ? `${reasoning}\n\n${question}` : question;
      await appendMessage(userId, { thread_id: threadId, role: "assistant", content });
      await savePendingAsk(userId, threadId, question, options);
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

      // run_pipeline: kick off the durable scan→classify Inngest chain and hand
      // off to the client, which polls the pipeline status and renders a live
      // loading view through scan → classify → persona → propose → done. We do
      // NOT wait here — a full first scan far exceeds a request's lifetime.
      if (!userId) {
        yield { type: "final", assistantText: "Onboarding is only available for signed-in accounts." };
        return;
      }
      const { inngest } = await import("@/inngest/client");
      await inngest.send({ name: "mail/scan", data: { userId, chain: true } });
      await appendMessage(userId, {
        thread_id: threadId,
        role: "tool",
        tool_name: "run_pipeline",
        content: "Started the mailbox scan + classification pipeline.",
      });
      await touchThread(userId, threadId);
      yield { type: "pipeline" };
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
