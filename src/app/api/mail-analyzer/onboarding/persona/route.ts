/**
 * Persona-confirm endpoint for the onboarding chat flow. Writes the confirmed
 * (optionally user-edited) persona as a `user_profile` memory — superseding any
 * prior one (rebuild) — appends a confirmation message to the chat thread, and
 * kicks off folder-proposal generation via Inngest. Multi-tenant only.
 */

import { NextResponse } from "next/server";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isMultiTenant()) {
    return NextResponse.json({ error: "onboarding is multi-tenant only" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = user.id;

  const body = (await req.json().catch(() => null)) as
    | { threadId?: number; persona?: string }
    | null;
  const persona = body?.persona?.trim();
  const threadId = body?.threadId;
  if (!persona) return NextResponse.json({ error: "persona required" }, { status: 400 });
  if (!threadId) return NextResponse.json({ error: "threadId required" }, { status: 400 });

  const { listMemoriesPg, writeMemoryPg, supersedeMemoryPg } = await import(
    "@/lib/analyzer-db-pg"
  );
  const prev = (await listMemoriesPg(userId, { kind: "user_profile" }))[0];
  const newId = await writeMemoryPg(userId, {
    kind: "user_profile",
    content: persona,
    source: "user_decision",
  });
  if (prev) await supersedeMemoryPg(userId, prev.id, newId);

  // The persona is now confirmed — retire the durable onboarding draft so it
  // isn't re-served or left dangling.
  const draft = (
    await listMemoriesPg(userId, { kind: "system", key: "onboarding_persona_draft", limit: 1 })
  )[0];
  if (draft) await supersedeMemoryPg(userId, draft.id, newId);

  const { appendMessagePg } = await import("@/lib/chat-db-pg");
  await appendMessagePg(userId, {
    thread_id: threadId,
    role: "assistant",
    content:
      "Your profile is set ✓ I'm preparing your folder proposals now — they'll appear on the Proposals tab in a few minutes. Ask me to walk you through them anytime.",
  });

  const { inngest } = await import("@/inngest/client");
  await inngest.send({ name: "mail/propose", data: { userId } });

  return NextResponse.json({ ok: true, id: newId });
}
