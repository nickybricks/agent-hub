import { NextResponse } from "next/server";
import {
  setFolderRuleStatus,
  updateFolderRuleMatch,
  FolderRuleStatus,
} from "@/lib/analyzer-db";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ruleId = Number(id);
  const body = (await req.json()) as {
    status?: FolderRuleStatus;
    match_value?: string;
    target_folder?: string | null;
  };
  if (body.match_value !== undefined || body.target_folder !== undefined) {
    // Need at least the match_value to update; preserve target if omitted.
    updateFolderRuleMatch(
      ruleId,
      body.match_value ?? "",
      body.target_folder === undefined ? null : body.target_folder
    );
  }
  if (body.status) setFolderRuleStatus(ruleId, body.status);
  return NextResponse.json({ ok: true });
}
