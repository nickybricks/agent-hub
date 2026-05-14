import { NextResponse } from "next/server";
import { getProposalsWithRules, getMessagesMatchingRule } from "@/lib/analyzer-db";

export const dynamic = "force-dynamic";

export async function GET() {
  const proposals = getProposalsWithRules();
  // Attach pending-message counts per rule so the UI can show "would move N".
  const enriched = proposals.map((p) => ({
    folder: p.folder,
    rules: p.rules.map((r) => ({
      ...r,
      pending_count: getMessagesMatchingRule(r).length,
    })),
  }));
  return NextResponse.json({ proposals: enriched });
}
