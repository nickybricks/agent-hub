#!/usr/bin/env -S npx tsx
/**
 * PM agent — once-a-day morning synthesis.
 *
 * Reads the Notion backlog + recent commits + any open Telegram
 * conversation, asks Claude to propose the next card with a short
 * plain-English reason, sends a 🔵 Telegram message, and persists
 * the proposed card id so the operator's "go" reply (handled by the
 * Telegram webhook in slice 1) can claim it.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/agent/pm.ts
 *
 * Env required:
 *   ANTHROPIC_API_KEY, DATABASE_URL, NOTION_TOKEN, NOTION_BACKLOG_DB_ID,
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */

import { ChatAnthropic } from "@langchain/anthropic";
import { execSync } from "node:child_process";
import { z } from "zod";
import { listBacklog, type BacklogItem } from "./backlog";
import {
  getOrCreateOpenConversation,
  appendTurn,
  setProposedCard,
} from "../../src/lib/pm-conversations";

const MODEL = "claude-sonnet-4-6";

const ProposalSchema = z.object({
  card_id: z
    .string()
    .describe(
      "Notion page id of the card you propose to work on next. Must be one of the ids in the provided backlog list.",
    ),
  message: z
    .string()
    .describe(
      "The full Telegram message to send the operator. Plain English, no jargon, no markdown bullets. Two short paragraphs max: (1) a one-sentence read on current state, (2) your proposed card and why, ending with a question like 'Go?' or 'Sound right?'. Keep it under 600 characters.",
    ),
});

type Proposal = z.infer<typeof ProposalSchema>;

function recentCommits(n = 8): string {
  try {
    return execSync(`git log -${n} --pretty=format:"%h %s" --no-merges`, {
      encoding: "utf8",
    }).trim();
  } catch {
    return "(no git history available)";
  }
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

async function sendTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set");
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: `🔵 PM morning\n${text}`,
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}

async function proposeNext(items: BacklogItem[]): Promise<Proposal> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const llm = new ChatAnthropic({ apiKey, model: MODEL, temperature: 0.2 });
  const structured = llm.withStructuredOutput(ProposalSchema);

  const system = [
    "You are the PM agent for a one-developer autonomous dev team.",
    "Once a day you review the backlog and propose the single next card to work on.",
    "Bias toward Hoch priority first, then Mittel, then Niedrig.",
    "Within the same priority band, prefer cards with sharp acceptance criteria over vague ones.",
    "Skip cards whose description is empty or clearly underspecified — note them in your message but pick a different one to propose.",
    "Write in plain English. No code identifiers, no internal jargon. Two short paragraphs max.",
  ].join(" ");

  const user = [
    "## Backlog (status=Backlog, sorted as Notion returned)",
    formatBacklog(items),
    "",
    "## Recent commits (newest first)",
    recentCommits(),
    "",
    "Pick exactly one card from the backlog above and produce the JSON the schema requires.",
    "The `card_id` MUST be one of the `id=` values listed.",
  ].join("\n");

  const result = (await structured.invoke([
    { role: "system", content: system },
    { role: "user", content: user },
  ])) as Proposal;

  const valid = items.find((i) => i.id === result.card_id);
  if (!valid) {
    throw new Error(`PM returned card_id ${result.card_id} not in backlog`);
  }
  return result;
}

async function main() {
  const items = await listBacklog("Backlog");
  if (items.length === 0) {
    await sendTelegram("Backlog is empty. Nothing to propose today.");
    console.log("backlog empty — nothing to do");
    return;
  }

  const proposal = await proposeNext(items);
  await sendTelegram(proposal.message);

  const chatId = process.env.TELEGRAM_CHAT_ID!;
  const convo = await getOrCreateOpenConversation(chatId);
  const ts = new Date().toISOString();
  await appendTurn(convo.id, { role: "pm", text: proposal.message, ts });
  await setProposedCard(convo.id, proposal.card_id);

  console.log(
    JSON.stringify(
      { proposed_card_id: proposal.card_id, message_preview: proposal.message.slice(0, 120) },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
