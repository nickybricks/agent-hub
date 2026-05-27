import { NextResponse } from "next/server";
import type { FolderRuleStatus } from "@/lib/analyzer-db";
import {
  setFolderRuleStatusPg,
  updateFolderRuleMatchPg,
  updateFolderRuleConfidencePg,
  deleteFolderRulePg,
  getFolderRulePg,
  writeMemoryPg,
} from "@/lib/analyzer-db-pg";
import { getAuthUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ruleId = Number(id);
  const body = (await req.json()) as {
    status?: FolderRuleStatus;
    match_value?: string;
    target_folder?: string | null;
    confidence?: number | null;
  };

  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = auth.userId;

  if (body.match_value !== undefined || body.target_folder !== undefined) {
    const mv = body.match_value ?? "";
    const tf = body.target_folder === undefined ? null : body.target_folder;
    await updateFolderRuleMatchPg(userId, ruleId, mv, tf);
  }
  if (body.confidence !== undefined) {
    await updateFolderRuleConfidencePg(userId, ruleId, body.confidence);
  }
  if (body.status) {
    await setFolderRuleStatusPg(userId, ruleId, body.status);
    const rule = await getFolderRulePg(userId, ruleId);
    await writeMemoryPg(userId, {
      kind: "user_pref",
      key: rule?.target_folder ?? null,
      source: "user_decision",
      content: `User set rule (${rule?.match_type}=${rule?.match_value} → ${rule?.target_folder}) status to "${body.status}".`,
    });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ruleId = Number(id);
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rule = await getFolderRulePg(auth.userId, ruleId);
  await deleteFolderRulePg(auth.userId, ruleId);
  if (rule) {
    await writeMemoryPg(auth.userId, {
      kind: "user_pref",
      key: rule.target_folder,
      source: "user_decision",
      content: `User deleted rule (${rule.match_type}=${rule.match_value} → ${rule.target_folder}).`,
    });
  }
  return NextResponse.json({ ok: true });
}
