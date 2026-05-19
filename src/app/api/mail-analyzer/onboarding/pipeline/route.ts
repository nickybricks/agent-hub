/**
 * Onboarding pipeline status. The scan→classify chain runs durably in Inngest;
 * the client polls this to render a live loading view and to know when to ask
 * for the persona (classify done) and when proposals are ready (done).
 *
 * phase: scanning → classifying → persona_ready → proposing → done | error
 */

import { NextResponse } from "next/server";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isMultiTenant()) {
    return NextResponse.json({ phase: "done" });
  }
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = user.id;

  const {
    getLatestScanRunPg,
    getSenderClassificationProgressPg,
    getProposalsWithRulesPg,
    listMemoriesPg,
  } = await import("@/lib/analyzer-db-pg");

  const run = await getLatestScanRunPg(userId);
  const scanned = run?.messages_scanned ?? 0;

  if (!run || run.status === "running") {
    return NextResponse.json({ phase: "scanning", scanned });
  }
  if (run.status === "error") {
    return NextResponse.json({ phase: "error", scanned, error: run.error ?? "scan failed" });
  }

  // Scan finished: gauge classification progress. Both counts use the same
  // senders↔messages join, same LOWER(), AND the same `!= selfEmail` exclusion
  // the classifier applies — without that exclusion the user's own address is
  // counted in `total` but never classified, so `classified` would stall one
  // short forever and onboarding would hang on the last sender.
  const { total: totalSenders, classified } =
    await getSenderClassificationProgressPg(userId);

  if (totalSenders === 0 || classified < totalSenders) {
    return NextResponse.json({
      phase: "classifying",
      scanned,
      classified,
      totalSenders,
    });
  }

  // Classification complete.
  const profile = await listMemoriesPg(userId, { kind: "user_profile", limit: 1 });
  if (profile.length === 0) {
    return NextResponse.json({ phase: "persona_ready", scanned, classified });
  }

  const proposals = await getProposalsWithRulesPg(userId);
  if (proposals.length === 0) {
    return NextResponse.json({ phase: "proposing", scanned, classified });
  }
  return NextResponse.json({
    phase: "done",
    scanned,
    classified,
    proposals: proposals.length,
  });
}
