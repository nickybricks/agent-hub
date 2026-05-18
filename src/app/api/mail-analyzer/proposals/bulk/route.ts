/**
 * Bulk proposal actions so the user isn't forced to click every rule:
 *   action="accept"  → mark in-scope proposed folders + rules accepted. No mail
 *                       is moved now; the triage cron auto-routes FUTURE mail.
 *   action="apply"   → additionally move all existing matching messages now
 *                       (calls applyRule per rule; also accepts the rule).
 * Optional `folderId` scopes the action to one folder card; omitted = all.
 */

import { NextResponse } from "next/server";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { applyRule, ApplyError } from "@/lib/apply-rule";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | { action?: "accept" | "apply"; folderId?: number }
    | null;
  const action = body?.action;
  if (action !== "accept" && action !== "apply") {
    return NextResponse.json({ error: "action must be accept|apply" }, { status: 400 });
  }
  const folderId = body?.folderId;

  let userId: string | null = null;
  if (isMultiTenant()) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    userId = user.id;
  }

  const dbPg = await import("@/lib/analyzer-db-pg");
  const dbLite = await import("@/lib/analyzer-db");

  const proposals = userId
    ? await dbPg.getProposalsWithRulesPg(userId)
    : dbLite.getProposalsWithRules();

  const scoped =
    folderId != null ? proposals.filter((p) => p.folder.id === folderId) : proposals;
  const rules = scoped.flatMap((p) => p.rules.filter((r) => r.status !== "rejected"));

  if (action === "accept") {
    for (const p of scoped) {
      if (p.folder.status === "proposed") {
        if (userId) await dbPg.setProposedFolderStatusPg(userId, p.folder.id, "accepted");
        else dbLite.setProposedFolderStatus(p.folder.id, "accepted");
      }
      for (const r of p.rules) {
        if (r.status === "proposed") {
          if (userId) await dbPg.setFolderRuleStatusPg(userId, r.id, "accepted");
          else dbLite.setFolderRuleStatus(r.id, "accepted");
        }
      }
    }
    return NextResponse.json({ ok: true, accepted: rules.length });
  }

  // action === "apply": accept + move existing matching mail, rule by rule.
  let moved = 0;
  let failed = 0;
  let appliedRules = 0;
  try {
    for (const r of rules) {
      const res = await applyRule(userId, r.id, true);
      moved += res.moved;
      failed += res.failed;
      appliedRules++;
    }
  } catch (err) {
    if (err instanceof ApplyError) {
      return NextResponse.json(
        { error: err.message, moved, failed, appliedRules },
        { status: err.status },
      );
    }
    throw err;
  }
  return NextResponse.json({ ok: true, moved, failed, appliedRules });
}
