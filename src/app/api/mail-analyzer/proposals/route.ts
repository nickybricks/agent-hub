import { NextResponse } from "next/server";
import { getProposalsWithRulesPg, getRulePendingCountsPg } from "@/lib/analyzer-db-pg";
import { getAuthUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = auth.userId;

  try {
    const proposals = await getProposalsWithRulesPg(userId);
    // ONE batched pair of grouped queries for all rules (was a per-rule
    // N+1 — 182 queries → ~45s).
    const allRules = proposals.flatMap((p) => p.rules);
    const counts = await getRulePendingCountsPg(userId, allRules);
    const enriched = proposals.map((p) => ({
      folder: p.folder,
      rules: p.rules.map((r) => ({ ...r, pending_count: counts.get(r.id) ?? 0 })),
    }));
    return NextResponse.json({ proposals: enriched });
  } catch (e) {
    console.error("proposals route error", e);
    return NextResponse.json({ proposals: [] });
  }
}
