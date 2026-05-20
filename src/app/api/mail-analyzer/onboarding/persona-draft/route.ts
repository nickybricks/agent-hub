/**
 * Synthesise a draft persona from the *completed* classified mailbox + the
 * questionnaire answers. The client calls this once when the pipeline reaches
 * `persona_ready`; it returns the draft to show in the editable confirm card.
 * Multi-tenant only.
 */

import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { synthesizePersona } from "@/lib/onboarding";
import { listMemoriesPg, writeMemoryPg } from "@/lib/analyzer-db-pg";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST() {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = auth.userId;

  // The draft is synthesised once and persisted as a `system` memory so a
  // mid-onboarding reload re-shows the *same* persona instead of generating a
  // fresh (different) one. Cleared on confirm / rebuild.
  const existing = (
    await listMemoriesPg(userId, { kind: "system", key: "onboarding_persona_draft", limit: 1 })
  )[0];
  if (existing?.content?.trim()) {
    return NextResponse.json({ persona: existing.content });
  }

  const persona = await synthesizePersona(userId);
  await writeMemoryPg(userId, {
    kind: "system",
    key: "onboarding_persona_draft",
    content: persona,
    source: "llm",
  });
  return NextResponse.json({ persona });
}
