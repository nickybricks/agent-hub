/**
 * Onboarding pipeline: trigger the scan + classify Inngest jobs, poll their
 * progress server-side (the chat LLM loop can't poll within its iteration
 * budget), and synthesise a draft persona from the questionnaire answers plus
 * the resulting mailbox composition. Used by the chat-agent `run_pipeline`
 * onboarding tool. Postgres / multi-tenant only.
 */

import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { createLLM } from "@/agent/summarize";
import { inngest } from "@/inngest/client";
import {
  getLatestScanRunPg,
  getCategoryDistributionPg,
  getSendersForProposalPg,
  listMemoriesPg,
} from "./analyzer-db-pg";

const SCAN_POLL_MS = 4000;
const SCAN_MAX_MS = 180_000;
const CLASSIFY_POLL_MS = 5000;
const CLASSIFY_MAX_MS = 90_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PERSONA_SYSTEM = `You write a short narrative "persona" describing an email user, addressed to them in the second person ("You ...").
Base it on their onboarding answers and the actual composition of their mailbox.
3–5 sentences. Warm, specific, concrete. No bullet lists, no headings, no preamble — just the persona paragraph.`;

export type PipelineEvent =
  | { kind: "progress"; label: string }
  | { kind: "persona"; text: string };

/**
 * Drive scan → classify with streamed progress, then yield a draft persona.
 * Yields `progress` events as the pipeline advances and a final `persona`.
 */
export async function* runOnboardingPipeline(
  userId: string,
): AsyncGenerator<PipelineEvent> {
  const emit = (label: string): PipelineEvent => ({ kind: "progress", label });
  // ── scan ──────────────────────────────────────────────────────────────────
  const prev = await getLatestScanRunPg(userId);
  const prevId = prev?.id ?? 0;
  yield emit("Starting your mailbox scan…");
  await inngest.send({ name: "mail/scan", data: { userId } });

  const scanStart = Date.now();
  let lastCount = -1;
  for (;;) {
    if (Date.now() - scanStart > SCAN_MAX_MS) {
      yield emit("Scan is still running — I'll keep it going in the background and build your profile now.");
      break;
    }
    await sleep(SCAN_POLL_MS);
    const run = await getLatestScanRunPg(userId);
    if (!run || run.id <= prevId) continue;
    const n = run.messages_scanned ?? 0;
    if (n !== lastCount) {
      yield emit(`Scanning your mailbox… ${n.toLocaleString()} messages`);
      lastCount = n;
    }
    if (run.status && run.status !== "running") {
      yield emit(`Scan complete — ${n.toLocaleString()} messages.`);
      break;
    }
  }

  // ── classify ──────────────────────────────────────────────────────────────
  yield emit("Classifying senders…");
  await inngest.send({ name: "mail/classify", data: { userId } });

  const clsStart = Date.now();
  let lastSenders = -1;
  for (;;) {
    if (Date.now() - clsStart > CLASSIFY_MAX_MS) break;
    await sleep(CLASSIFY_POLL_MS);
    const dist = await getCategoryDistributionPg(userId);
    const total = dist.reduce((s, c) => s + Number(c.senders), 0);
    if (total === lastSenders && total > 0) break; // stabilised
    if (total !== lastSenders) {
      yield emit(`Classifying senders… ${total.toLocaleString()} classified`);
      lastSenders = total;
    }
  }

  // ── persona synthesis ─────────────────────────────────────────────────────
  yield emit("Building your profile…");
  const [answers, dist, topSenders] = await Promise.all([
    listMemoriesPg(userId, { kind: "user_pref", limit: 50 }),
    getCategoryDistributionPg(userId),
    getSendersForProposalPg(userId, 3, 30),
  ]);

  const answerLines = answers
    .filter((a) => (a.key ?? "").startsWith("onboarding:"))
    .map((a) => `- ${(a.key ?? "").replace("onboarding:", "")}: ${a.content}`)
    .join("\n");
  const distLines = dist
    .map((c) => `- ${c.category}: ${Number(c.msgs).toLocaleString()} messages from ${c.senders} senders`)
    .join("\n");
  const senderLines = topSenders
    .map((s) => `- ${s.email}${s.category ? ` [${s.category}]` : ""} (${s.message_count})`)
    .join("\n");

  const userPrompt = `Their onboarding answers:
${answerLines || "(none provided)"}

Mailbox category distribution:
${distLines || "(not classified yet)"}

Top senders by volume:
${senderLines || "(none yet)"}`;

  const llm = createLLM({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    systemPrompt: PERSONA_SYSTEM,
  });
  const res = await llm.invoke(
    [new SystemMessage(PERSONA_SYSTEM), new HumanMessage(userPrompt)],
    { tags: ["mail-analyzer", "onboarding", "persona"] },
  );
  const text = typeof res.content === "string" ? res.content : String(res.content);
  yield {
    kind: "persona",
    text: text.trim() || "You rely on email heavily and want a calm, well-organised mailbox.",
  };
}
