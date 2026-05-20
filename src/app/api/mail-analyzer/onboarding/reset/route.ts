/**
 * Rebuild profile: supersede the user's current `user_profile` memory so the
 * onboarding chat flow re-activates (onboarding is "active" while no active
 * user_profile exists). No hard delete — the prior persona stays in history,
 * superseded by an auditable note recording the rebuild request. MT only.
 */

import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { listMemoriesPg, writeMemoryPg, supersedeMemoryPg } from "@/lib/analyzer-db-pg";

export const dynamic = "force-dynamic";

export async function POST() {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = auth.userId;

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
