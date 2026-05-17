/**
 * Persona synthesis for onboarding. The scan → classify pipeline runs durably
 * via chained Inngest functions (see src/inngest/functions.ts); this module
 * just turns the *completed* mailbox composition + questionnaire answers into a
 * draft persona. Postgres / multi-tenant only.
 */

import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { createLLM } from "@/agent/summarize";
import {
  getCategoryDistributionPg,
  getSendersForProposalPg,
  listMemoriesPg,
} from "./analyzer-db-pg";

const PERSONA_SYSTEM = `You write a short narrative "persona" describing an email user, addressed to them in the second person ("You ...").
Base it on their onboarding answers and the actual composition of their mailbox.
3–5 sentences. Warm, specific, concrete. No bullet lists, no headings, no preamble — just the persona paragraph.`;

/** Synthesise a draft persona from the full classified sender set + answers. */
export async function synthesizePersona(userId: string): Promise<string> {
  const [answers, dist, topSenders] = await Promise.all([
    listMemoriesPg(userId, { kind: "user_pref", limit: 50 }),
    getCategoryDistributionPg(userId),
    getSendersForProposalPg(userId, 3, 200),
  ]);

  const answerLines = answers
    .filter((a) => (a.key ?? "").startsWith("onboarding:"))
    .map((a) => `- ${(a.key ?? "").replace("onboarding:", "")}: ${a.content}`)
    .join("\n");
  const distLines = dist
    .map((c) => `- ${c.category}: ${Number(c.msgs).toLocaleString()} messages from ${c.senders} senders`)
    .join("\n");
  const senderLines = topSenders
    .slice(0, 40)
    .map((s) => `- ${s.email}${s.category ? ` [${s.category}]` : ""} (${s.message_count})`)
    .join("\n");

  const userPrompt = `Their onboarding answers:
${answerLines || "(none provided)"}

Mailbox category distribution (${dist.length} categories):
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
  return text.trim() || "You rely on email heavily and want a calm, well-organised mailbox.";
}
