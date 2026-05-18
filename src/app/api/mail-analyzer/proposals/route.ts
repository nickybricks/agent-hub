import { NextResponse } from "next/server";
import { getProposalsWithRules, getMessagesMatchingRule } from "@/lib/analyzer-db";
import { getProposalsWithRulesPg, getRulePendingCountsPg } from "@/lib/analyzer-db-pg";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  let userId: string | null = null;
  if (isMultiTenant()) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    userId = user.id;
  }

  try {
    const proposals = userId ? await getProposalsWithRulesPg(userId) : getProposalsWithRules();
    // Attach pending-message counts so the UI can show "would move N".
    // MT: ONE batched pair of grouped queries for all rules (was a per-rule
    // N+1 — 182 queries → ~45s). SQLite (local) stays per-rule (in-process).
    let enriched;
    if (userId) {
      const allRules = proposals.flatMap((p) => p.rules);
      const counts = await getRulePendingCountsPg(userId, allRules);
      enriched = proposals.map((p) => ({
        folder: p.folder,
        rules: p.rules.map((r) => ({ ...r, pending_count: counts.get(r.id) ?? 0 })),
      }));
    } else {
      enriched = proposals.map((p) => ({
        folder: p.folder,
        rules: p.rules.map((r) => ({
          ...r,
          pending_count: getMessagesMatchingRule(r).length,
        })),
      }));
    }
    return NextResponse.json({ proposals: enriched });
  } catch (e) {
    console.error("proposals route error", e);
    return NextResponse.json({ proposals: [] });
  }
}
