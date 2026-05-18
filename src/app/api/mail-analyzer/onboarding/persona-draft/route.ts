/**
 * Synthesise a draft persona from the *completed* classified mailbox + the
 * questionnaire answers. The client calls this once when the pipeline reaches
 * `persona_ready`; it returns the draft to show in the editable confirm card.
 * Multi-tenant only.
 */

import { NextResponse } from "next/server";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { synthesizePersona } from "@/lib/onboarding";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST() {
  if (!isMultiTenant()) {
    return NextResponse.json({ error: "onboarding is multi-tenant only" }, { status: 400 });
  }
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // The draft is synthesised once and persisted as a `system` memory so a
  // mid-onboarding reload re-shows the *same* persona instead of generating a
  // fresh (different) one. Cleared on confirm / rebuild.
  const { listMemoriesPg, writeMemoryPg } = await import("@/lib/analyzer-db-pg");
  const existing = (
    await listMemoriesPg(user.id, { kind: "system", key: "onboarding_persona_draft", limit: 1 })
  )[0];
  if (existing?.content?.trim()) {
    return NextResponse.json({ persona: existing.content });
  }

  const persona = await synthesizePersona(user.id);
  await writeMemoryPg(user.id, {
    kind: "system",
    key: "onboarding_persona_draft",
    content: persona,
    source: "llm",
  });
  return NextResponse.json({ persona });
}
