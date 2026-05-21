#!/usr/bin/env -S npx tsx
/**
 * Telegram notification helper for the agent team flow.
 *
 * Usage (CLI):
 *   npx tsx scripts/agent/notify.ts "your message here"
 *   npx tsx scripts/agent/notify.ts --kind=pr "PR ready: <url>"
 *
 * Usage (import):
 *   import { notify } from "./notify";
 *   await notify("Agent stuck", { kind: "stuck" });
 */

type NotifyKind = "pr" | "decision" | "stuck" | "status" | "info";

const PREFIX: Record<NotifyKind, string> = {
  pr: "🟢 PR ready",
  decision: "🟡 Decision needed",
  stuck: "🔴 Agent stuck",
  status: "🔵 Status",
  info: "ℹ️",
};

export async function notify(message: string, opts: { kind?: NotifyKind } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in .env.local");
  }
  const prefix = PREFIX[opts.kind ?? "info"];
  const text = `${prefix}\n${message}`;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }),
  });
  if (!res.ok) {
    throw new Error(`Telegram API ${res.status}: ${await res.text()}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let kind: NotifyKind = "info";
  const msgParts: string[] = [];
  for (const a of args) {
    if (a.startsWith("--kind=")) kind = a.slice(7) as NotifyKind;
    else msgParts.push(a);
  }
  const message = msgParts.join(" ").trim();
  if (!message) {
    console.error("usage: notify.ts [--kind=pr|decision|stuck|status|info] <message>");
    process.exit(1);
  }
  notify(message, { kind }).then(
    () => console.log("sent"),
    (e) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}
