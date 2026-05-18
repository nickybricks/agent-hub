import { NextResponse } from "next/server";
import { getProposalsWithRules, getMessagesMatchingRule } from "@/lib/analyzer-db";
import { getProposalsWithRulesPg, getMessagesMatchingRulePg } from "@/lib/analyzer-db-pg";
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
    // Attach pending-message counts per rule so the UI can show "would move N".
    const enriched = await Promise.all(
      proposals.map(async (p) => ({
        folder: p.folder,
        rules: await Promise.all(
          p.rules.map(async (r) => ({
            ...r,
            pending_count: userId
              ? (await getMessagesMatchingRulePg(userId, r)).length
              : getMessagesMatchingRule(r).length,
          }))
        ),
      }))
    );
    return NextResponse.json({ proposals: enriched });
  } catch (e) {
    console.error("proposals route error", e);
    return NextResponse.json({ proposals: [] });
  }
}
