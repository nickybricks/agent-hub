import { NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Vercel cron entry point for the PM agent's daily morning thread.
// Vercel sends `Authorization: Bearer $CRON_SECRET`. We verify, then
// fire workflow_dispatch on the pm-morning.yml GH Actions workflow.
// The actual synthesis (Claude call, Telegram, DB writes) happens in
// the runner because Vercel Hobby's 60s timeout is too tight for a
// chain that includes git clone + npm ci + LangChain.

const GH_REPO = "nickybricks/agent-hub";
const WORKFLOW = "pm-morning.yml";

async function dispatchWorkflow(): Promise<{ ok: boolean; status?: number; body?: string }> {
  const token = process.env.AGENT_GH_TOKEN;
  if (!token) return { ok: false, body: "AGENT_GH_TOKEN not set" };
  const res = await fetch(
    `https://api.github.com/repos/${GH_REPO}/actions/workflows/${WORKFLOW}/dispatches`,
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
  if (!res.ok) return { ok: false, status: res.status, body: await res.text() };
  return { ok: true };
}

export async function GET(req: Request) {
  if (!authorizeCron(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const result = await dispatchWorkflow();
  if (!result.ok) {
    console.error("[pm-morning-cron] dispatch failed", result);
    return NextResponse.json(
      { ok: false, reason: "dispatch_failed", detail: result.body },
      { status: 502 },
    );
  }
  console.log("[pm-morning-cron] dispatched");
  return NextResponse.json({ ok: true, dispatched: WORKFLOW });
}
