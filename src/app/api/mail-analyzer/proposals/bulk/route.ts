/**
 * Bulk proposal actions so the user isn't forced to click every rule:
 *   action="accept"  → mark in-scope proposed folders + rules accepted. No mail
 *                       is moved now; the triage cron auto-routes FUTURE mail.
 *   action="apply"   → additionally move all existing matching messages now
 *                       (calls applyRule per rule; also accepts the rule).
 * Optional `folderId` scopes the action to one folder card; omitted = all.
 */

import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { applyRule, ApplyError } from "@/lib/apply-rule";
import {
  getProposalsWithRulesPg,
  setProposedFolderStatusPg,
  setFolderRuleStatusPg,
} from "@/lib/analyzer-db-pg";

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

  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = auth.userId;

  const proposals = await getProposalsWithRulesPg(userId);

  const scoped =
    folderId != null ? proposals.filter((p) => p.folder.id === folderId) : proposals;
  const rules = scoped.flatMap((p) => p.rules.filter((r) => r.status !== "rejected"));

  if (action === "accept") {
    for (const p of scoped) {
      if (p.folder.status === "proposed") {
        await setProposedFolderStatusPg(userId, p.folder.id, "accepted");
      }
      for (const r of p.rules) {
        if (r.status === "proposed") {
          await setFolderRuleStatusPg(userId, r.id, "accepted");
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
