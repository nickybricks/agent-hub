import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Receives signals from Notion when the backlog kanban changes and pokes
// the Engineer Poller workflow on GitHub Actions so it fires right away
// instead of waiting for the cron schedule.
//
// Setup:
//   1. Create a Notion webhook subscription pointing at this URL. Notion
//      will respond with a verification_token in the first request payload.
//   2. The route logs that token. Copy it from Vercel logs and paste it
//      into the Notion integration UI to confirm ownership.
//   3. Notion gives you a signing secret. Set NOTION_WEBHOOK_SECRET in
//      Vercel env to that value. From then on, real events arrive with
//      X-Notion-Signature headers we verify here.
//
// We don't parse Notion's payload — any verified signal pokes the poller,
// which then queries Notion fresh and decides what to do (idempotent).

const GH_REPO = "nickybricks/agent-hub";
const POLLER_WORKFLOW = "engineer-poller.yml";

// We only care about events that could mean a card moved between status
// columns. Comments, user changes, database-schema events, etc. are noise
// — pokin the poller for those is wasted GH Actions minutes.
//
// Notion's webhook payload shape varies by event type and has shifted
// during beta. We look at common locations for a type string and use
// substring matching to be tolerant of minor format changes.
function extractEventType(payload: Record<string, unknown>): string {
  const candidates: unknown[] = [
    payload.type,
    payload.event_type,
    payload.event,
    (payload.event as Record<string, unknown> | undefined)?.type,
    (payload.data as Record<string, unknown> | undefined)?.type,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c.toLowerCase();
  }
  return "";
}

function shouldPokePoller(payload: Record<string, unknown>): {
  poke: boolean;
  reason: string;
} {
  const type = extractEventType(payload);

  // Explicit skip list — events that definitely don't mean a status change.
  if (type.includes("comment")) return { poke: false, reason: `skip:${type}` };
  if (type.startsWith("user.")) return { poke: false, reason: `skip:${type}` };
  if (type.startsWith("workspace.")) return { poke: false, reason: `skip:${type}` };
  if (type.startsWith("database.schema")) return { poke: false, reason: `skip:${type}` };

  // Page property/move/status changes are exactly what we want.
  if (
    type.includes("properties_updated") ||
    type.includes("page.updated") ||
    type.includes("page.moved") ||
    type.includes("status")
  ) {
    return { poke: true, reason: `match:${type}` };
  }

  // Page create/delete events are borderline — a freshly created card in
  // "working on it" is rare but possible. Cheaper to poke than miss it.
  if (type.startsWith("page.")) return { poke: true, reason: `page:${type}` };

  // Unknown event shapes — log so we can tighten the filter later. Default
  // to NOT poking so a future Notion beta change doesn't accidentally flood
  // the poller. If something stops working, check the log.
  return { poke: false, reason: `unknown:${type || "(empty)"}` };
}

function verifySignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.NOTION_WEBHOOK_SECRET;
  if (!secret || !signature) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function pokePoller(): Promise<{ ok: boolean; status?: number; body?: string }> {
  const token = process.env.AGENT_GH_TOKEN;
  if (!token) return { ok: false, body: "AGENT_GH_TOKEN not set" };
  const res = await fetch(
    `https://api.github.com/repos/${GH_REPO}/actions/workflows/${POLLER_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: "main" }),
    },
  );
  if (!res.ok) {
    return { ok: false, status: res.status, body: await res.text() };
  }
  return { ok: true };
}

export async function POST(req: Request) {
  const rawBody = await req.text();

  // Notion's initial subscription handshake. The first request contains a
  // verification_token but no signature header. Log it so the human can
  // paste it back into the Notion integration UI.
  let parsed: { verification_token?: string } | null = null;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }
  if (parsed?.verification_token) {
    console.log(`[notion-webhook] verification_token=${parsed.verification_token}`);
    return NextResponse.json({ ok: true, kind: "verification" });
  }

  const signature = req.headers.get("x-notion-signature");
  if (!verifySignature(rawBody, signature)) {
    return NextResponse.json({ ok: false, reason: "invalid_signature" }, { status: 401 });
  }

  const decision = shouldPokePoller(parsed as Record<string, unknown>);
  if (!decision.poke) {
    console.log(`[notion-webhook] ${decision.reason}`);
    return NextResponse.json({ ok: true, skipped: decision.reason });
  }

  const result = await pokePoller();
  if (!result.ok) {
    console.error(`[notion-webhook] poller poke failed`, result);
    return NextResponse.json(
      { ok: false, reason: "dispatch_failed", detail: result.body },
      { status: 502 },
    );
  }

  console.log(`[notion-webhook] poked poller (${decision.reason})`);
  return NextResponse.json({ ok: true, poked: POLLER_WORKFLOW, reason: decision.reason });
}

// Notion sometimes hits the URL with GET when you configure it in the UI.
// Respond cheaply so the setup screen shows a green check.
export async function GET() {
  return NextResponse.json({ ok: true, hint: "POST endpoint for Notion webhooks" });
}
