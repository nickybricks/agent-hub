import { NextResponse } from "next/server";
import {
  setFolderRuleStatus,
  updateFolderRuleMatch,
  FolderRuleStatus,
  getFolderRule,
  writeMemory,
} from "@/lib/analyzer-db";
import {
  setFolderRuleStatusPg,
  updateFolderRuleMatchPg,
  getFolderRulePg,
  writeMemoryPg,
} from "@/lib/analyzer-db-pg";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ruleId = Number(id);
  const body = (await req.json()) as {
    status?: FolderRuleStatus;
    match_value?: string;
    target_folder?: string | null;
  };

  let userId: string | null = null;
  if (isMultiTenant()) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    userId = user.id;
  }

  if (body.match_value !== undefined || body.target_folder !== undefined) {
    // Need at least the match_value to update; preserve target if omitted.
    const mv = body.match_value ?? "";
    const tf = body.target_folder === undefined ? null : body.target_folder;
    if (userId) await updateFolderRuleMatchPg(userId, ruleId, mv, tf);
    else updateFolderRuleMatch(ruleId, mv, tf);
  }
  if (body.status) {
    if (userId) await setFolderRuleStatusPg(userId, ruleId, body.status);
    else setFolderRuleStatus(ruleId, body.status);
  }
  if (body.status) {
    const rule = userId ? await getFolderRulePg(userId, ruleId) : getFolderRule(ruleId);
    const memoInput = {
      kind: "user_pref" as const,
      key: rule?.target_folder ?? null,
      source: "user_decision" as const,
      content: `User set rule (${rule?.match_type}=${rule?.match_value} → ${rule?.target_folder}) status to "${body.status}".`,
    };
    if (userId) await writeMemoryPg(userId, memoInput);
    else writeMemory(memoInput);
  }
  return NextResponse.json({ ok: true });
}
