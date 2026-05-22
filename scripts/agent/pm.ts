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

import { execSync } from "node:child_process";
import { listBacklog } from "./backlog";
import {
  getOrCreateOpenConversation,
  appendTurn,
  setProposedCard,
} from "../../src/lib/pm-conversations";
import { runPm } from "../../src/lib/pm-agent";

function recentCommits(n = 8): string {
  try {
    return execSync(`git log -${n} --pretty=format:"%h %s" --no-merges`, {
      encoding: "utf8",
    }).trim();
  } catch {
    return "(no git history available)";
  }
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

async function main() {
  const items = await listBacklog("Backlog");
  if (items.length === 0) {
    await sendTelegram("Backlog is empty. Nothing to propose today.");
    console.log("backlog empty — nothing to do");
    return;
  }

  const result = await runPm({
    backlog: items,
    mode: { kind: "morning", recentCommits: recentCommits() },
  });
  if (!result.card_id) {
    throw new Error("morning thread must propose a card; got null card_id");
  }

  await sendTelegram(result.message);

  const chatId = process.env.TELEGRAM_CHAT_ID!;
  const convo = await getOrCreateOpenConversation(chatId);
  const ts = new Date().toISOString();
  await appendTurn(convo.id, { role: "pm", text: result.message, ts });
  await setProposedCard(convo.id, result.card_id);

  console.log(
    JSON.stringify(
      { proposed_card_id: result.card_id, message_preview: result.message.slice(0, 120) },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
