/**
 * PM agent core — single LLM entry point shared by:
 *   - scripts/agent/pm.ts (morning cron via GH Actions)
 *   - /api/webhook/telegram (free-text replies via Vercel)
 *
 * The "morning" call passes recent commits and no transcript.
 * The "reply" call passes the existing transcript + the user's latest
 * message. Both return the same shape.
 */

import { ChatAnthropic } from "@langchain/anthropic";
import { z } from "zod";
import type { BacklogItem } from "../../scripts/agent/backlog";
import type { TranscriptTurn } from "./pm-conversations";

const MODEL = "claude-sonnet-4-6";

const ResultSchema = z.object({
  card_id: z
    .string()
    .nullable()
    .describe(
      "Notion page id of the card you propose to work on next. Use null if your reply is purely conversational and doesn't change the current proposal. Otherwise must be one of the ids in the provided backlog list.",
    ),
  message: z
    .string()
    .describe(
      "The full Telegram message to send the operator. Plain English, no jargon, no markdown bullets. Conversational — match the operator's tone in the transcript. Keep it under 600 characters unless you have a specific reason to go longer.",
    ),
});

export type PmResult = z.infer<typeof ResultSchema>;

export type PmMode =
  | { kind: "morning"; recentCommits: string }
  | { kind: "reply"; transcript: TranscriptTurn[]; latestUserMessage: string };

export interface PmInput {
  backlog: BacklogItem[];
  currentProposedCardId?: string | null;
  mode: PmMode;
}

function formatBacklog(items: BacklogItem[]): string {
  if (items.length === 0) return "(backlog is empty)";
  return items
    .map(
      (i, idx) =>
        `${idx + 1}. id=${i.id}  priority=${i.priority ?? "—"}  title=${i.title}` +
        (i.description ? `\n     ${i.description.replace(/\n/g, " ").slice(0, 280)}` : ""),
    )
    .join("\n");
}

function formatTranscript(turns: TranscriptTurn[]): string {
  if (turns.length === 0) return "(no prior turns)";
  return turns
    .slice(-12)
    .map((t) => `[${t.role}] ${t.text}`)
    .join("\n");
}

function systemPrompt(): string {
  return [
    "You are the PM agent for a one-developer autonomous dev team.",
    "You review a Notion backlog and propose what to work on next, and you respond when the operator pushes back, asks questions, or changes direction.",
    "You write in plain English. No code identifiers, no internal jargon. Short paragraphs.",
    "Priority bands: Hoch > Mittel > Niedrig. Within a band, prefer cards with sharp acceptance criteria.",
    "When you propose a card, give a one-sentence reason. End with a question like 'Go?' or 'Sound right?' so the operator knows you're waiting on them.",
    "When the operator asks a question that you can't answer from the provided context, say so honestly — don't invent details.",
    "When the operator pushes back on your pick ('do Y instead', 'not that one'), swap to the card they're pointing at if you can identify it, otherwise ask which one they mean.",
    "If your reply is purely conversational (no card change), set card_id to null. If you're proposing or swapping a card, set card_id to its Notion id.",
  ].join(" ");
}

function userPrompt(input: PmInput): string {
  const lines: string[] = [];

  lines.push("## Backlog (status=Backlog)");
  lines.push(formatBacklog(input.backlog));
  lines.push("");

  if (input.currentProposedCardId) {
    const current = input.backlog.find((b) => b.id === input.currentProposedCardId);
    lines.push("## Currently proposed card");
    lines.push(
      current
        ? `id=${current.id}  title=${current.title}`
        : `id=${input.currentProposedCardId} (no longer in Backlog — may have been claimed or removed)`,
    );
    lines.push("");
  }

  if (input.mode.kind === "morning") {
    lines.push("## Recent commits (newest first)");
    lines.push(input.mode.recentCommits);
    lines.push("");
    lines.push(
      "This is the morning thread. Pick one card from the backlog and produce a JSON result. card_id MUST be one of the id= values above. Two short paragraphs max in the message.",
    );
  } else {
    lines.push("## Conversation so far");
    lines.push(formatTranscript(input.mode.transcript));
    lines.push("");
    lines.push("## Operator's latest message");
    lines.push(input.mode.latestUserMessage);
    lines.push("");
    lines.push(
      "Reply to the operator. If they're swapping the pick, set card_id to the new card. If they're just chatting or asking a question, set card_id to null.",
    );
  }

  return lines.join("\n");
}

export async function runPm(input: PmInput): Promise<PmResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const llm = new ChatAnthropic({ apiKey, model: MODEL, temperature: 0.2 });
  const structured = llm.withStructuredOutput(ResultSchema);

  const result = (await structured.invoke([
    { role: "system", content: systemPrompt() },
    { role: "user", content: userPrompt(input) },
  ])) as PmResult;

  if (result.card_id !== null) {
    const valid = input.backlog.find((b) => b.id === result.card_id);
    if (!valid) {
      throw new Error(`PM returned card_id ${result.card_id} not in backlog`);
    }
  }
  return result;
}
