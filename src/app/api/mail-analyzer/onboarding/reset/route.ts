/**
 * Rebuild profile: supersede the user's current `user_profile` memory so the
 * onboarding chat flow re-activates (onboarding is "active" while no active
 * user_profile exists). No hard delete — the prior persona stays in history,
 * superseded by an auditable note recording the rebuild request. MT only.
 */

import { NextResponse } from "next/server";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST() {
  if (!isMultiTenant()) {
    return NextResponse.json({ error: "onboarding is multi-tenant only" }, { status: 400 });
  }
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = user.id;

  const { listMemoriesPg, writeMemoryPg, supersedeMemoryPg } = await import(
    "@/lib/analyzer-db-pg"
  );
  const prev = (await listMemoriesPg(userId, { kind: "user_profile" }))[0];
  // Also retire any durable onboarding persona draft so the rebuild
  // re-synthesises from scratch rather than re-showing the stale draft.
  const draft = (
    await listMemoriesPg(userId, { kind: "system", key: "onboarding_persona_draft", limit: 1 })
  )[0];
  if (prev || draft) {
    const noteId = await writeMemoryPg(userId, {
      kind: "user_pref",
      key: "profile_rebuild_requested",
      content: `User requested a profile rebuild on ${new Date().toISOString().slice(0, 10)}.`,
      source: "user_decision",
    });
    if (prev) await supersedeMemoryPg(userId, prev.id, noteId);
    if (draft) await supersedeMemoryPg(userId, draft.id, noteId);
  }
  return NextResponse.json({ ok: true });
}
