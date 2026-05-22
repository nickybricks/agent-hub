import { NextResponse } from "next/server";
import {
  appendTurn,
  getOrCreateOpenConversation,
  markDecided,
  setProposedCard,
  type PmConversation,
} from "@/lib/pm-conversations";
import { runPm } from "@/lib/pm-agent";
import { claim, createCard, listBacklog } from "../../../../../scripts/agent/backlog";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Receives Telegram updates and routes them to the PM conversation state.
//
// Setup:
//   1. Set TELEGRAM_WEBHOOK_SECRET in Vercel env (any random string).
//   2. Register the webhook with Telegram, passing the secret:
//        curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
//          -d url="https://mail-workflow.vercel.app/api/webhook/telegram" \
//          -d secret_token="<TELEGRAM_WEBHOOK_SECRET>"
//   3. Telegram echoes the secret back in the X-Telegram-Bot-Api-Secret-Token
//      header on every delivery. We compare and reject anything else.
//
// Intents:
//   add: <title>  — create a Notion card in Backlog
//   go / yes / ok — claim the PM-proposed card (Engineer fires via Notion webhook)
//   free-text     — route to the PM LLM for a conversational reply; may swap
//                   the proposed card if the operator pushes back

type TelegramMessage = {
  message_id: number;
  chat: { id: number | string };
  text?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

type Intent =
  | { kind: "go" }
  | { kind: "add"; title: string }
  | { kind: "free_text" };

const GO_PATTERNS = /^(go|yes|y|ok|okay|ship it|do it|los|ja)[.!]?$/i;
const ADD_PATTERN = /^add\s*[:\-]\s*(.+)$/i;

function classify(text: string): Intent {
  const trimmed = text.trim();
  if (GO_PATTERNS.test(trimmed)) return { kind: "go" };
  const addMatch = trimmed.match(ADD_PATTERN);
  if (addMatch) return { kind: "add", title: addMatch[1].trim() };
  return { kind: "free_text" };
}

async function sendReply(chatId: number | string, text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("[telegram-webhook] TELEGRAM_BOT_TOKEN not set, skipping reply");
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!res.ok) {
    console.error(`[telegram-webhook] sendMessage ${res.status}: ${await res.text()}`);
  }
}

async function handleGo(
  convo: PmConversation,
  chatId: number | string,
): Promise<string> {
  if (!convo.proposedCardId) {
    return "No card proposed yet. The PM agent's morning thread isn't online yet — for now, move a card to \"working on it\" in Notion directly, or text `add: <description>` to create one.";
  }
  await claim(convo.proposedCardId);
  await markDecided(convo.id, convo.proposedCardId);
  void chatId;
  return "🟢 Card moved to \"working on it\" — Engineer is dispatching.";
}

async function handleAdd(title: string): Promise<string> {
  const card = await createCard({ title });
  return `🔵 Card created in Backlog: "${card.title}"\n${card.url}`;
}

async function handleFreeText(
  convo: PmConversation,
  userText: string,
): Promise<{ reply: string; newProposedCardId: string | null | undefined }> {
  const backlog = await listBacklog("Backlog");
  const result = await runPm({
    backlog,
    currentProposedCardId: convo.proposedCardId,
    mode: {
      kind: "reply",
      transcript: convo.transcript,
      latestUserMessage: userText,
    },
  });
  // undefined = don't touch proposedCardId; null/string = update it.
  // If the LLM returns null, that's a chat-only reply and we leave the
  // existing proposal alone (operator can still reply `go` to claim it).
  const newProposedCardId = result.card_id ? result.card_id : undefined;
  return { reply: `🔵 ${result.message}`, newProposedCardId };
}

export async function POST(req: Request) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, reason: "TELEGRAM_WEBHOOK_SECRET not set" },
      { status: 500 },
    );
  }
  const got = req.headers.get("x-telegram-bot-api-secret-token");
  if (got !== expected) {
    return NextResponse.json({ ok: false, reason: "invalid_secret" }, { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const msg = update.message ?? update.edited_message;
  if (!msg?.text) {
    return NextResponse.json({ ok: true, skipped: "no_text" });
  }

  const allowedChat = process.env.TELEGRAM_CHAT_ID;
  const chatIdStr = String(msg.chat.id);
  if (allowedChat && chatIdStr !== allowedChat) {
    console.warn(`[telegram-webhook] reject chat ${chatIdStr} (expected ${allowedChat})`);
    return NextResponse.json({ ok: true, skipped: "chat_not_allowed" });
  }

  const convo = await getOrCreateOpenConversation(chatIdStr);
  const ts = new Date().toISOString();
  await appendTurn(convo.id, { role: "user", text: msg.text, ts });

  const intent = classify(msg.text);
  let reply: string;
  try {
    if (intent.kind === "go") {
      reply = await handleGo(convo, msg.chat.id);
      if (convo.proposedCardId) {
        // markDecided already ran; clear proposed for the next thread.
        await setProposedCard(convo.id, null);
      }
    } else if (intent.kind === "add") {
      reply = await handleAdd(intent.title);
    } else {
      const ft = await handleFreeText(convo, msg.text);
      reply = ft.reply;
      if (ft.newProposedCardId !== undefined) {
        await setProposedCard(convo.id, ft.newProposedCardId);
      }
    }
  } catch (e) {
    console.error("[telegram-webhook] handler error", e);
    reply = `🔴 Something went wrong: ${(e as Error).message}`;
  }

  await appendTurn(convo.id, { role: "pm", text: reply, ts: new Date().toISOString() });
  await sendReply(msg.chat.id, reply);

  return NextResponse.json({ ok: true, intent: intent.kind });
}

export async function GET() {
  return NextResponse.json({ ok: true, hint: "POST endpoint for Telegram webhooks" });
}
