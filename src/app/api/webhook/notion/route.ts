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

  const result = await pokePoller();
  if (!result.ok) {
    console.error(`[notion-webhook] poker poke failed`, result);
    return NextResponse.json(
      { ok: false, reason: "dispatch_failed", detail: result.body },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, poked: POLLER_WORKFLOW });
}

// Notion sometimes hits the URL with GET when you configure it in the UI.
// Respond cheaply so the setup screen shows a green check.
export async function GET() {
  return NextResponse.json({ ok: true, hint: "POST endpoint for Notion webhooks" });
}
