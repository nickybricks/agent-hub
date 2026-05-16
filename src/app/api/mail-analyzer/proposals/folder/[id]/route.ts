import { NextResponse } from "next/server";
import {
  setProposedFolderStatus,
  updateProposedFolderPath,
  ProposedFolderStatus,
  writeMemory,
  getDb,
} from "@/lib/analyzer-db";
import {
  setProposedFolderStatusPg,
  updateProposedFolderPathPg,
  getProposedFolderByIdPg,
  writeMemoryPg,
} from "@/lib/analyzer-db-pg";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const folderId = Number(id);
  const body = (await req.json()) as { status?: ProposedFolderStatus; path?: string };

  let userId: string | null = null;
  if (isMultiTenant()) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    userId = user.id;
  }

  const before = userId
    ? await getProposedFolderByIdPg(userId, folderId)
    : (getDb().prepare(`SELECT path FROM proposed_folders WHERE id = ?`).get(folderId) as { path: string } | undefined);
  if (body.path) {
    if (userId) await updateProposedFolderPathPg(userId, folderId, body.path);
    else updateProposedFolderPath(folderId, body.path);
  }
  if (body.status) {
    if (userId) await setProposedFolderStatusPg(userId, folderId, body.status);
    else setProposedFolderStatus(folderId, body.status);
  }
  const finalPath = body.path ?? before?.path ?? null;
  const memo = async (input: Parameters<typeof writeMemory>[0]) =>
    userId ? writeMemoryPg(userId, input) : writeMemory(input);
  if (body.path && before && before.path !== body.path) {
    await memo({
      kind: "user_pref",
      key: body.path,
      source: "user_decision",
      content: `User renamed proposed folder "${before.path}" to "${body.path}".`,
    });
  }
  if (body.status) {
    await memo({
      kind: "user_pref",
      key: finalPath,
      source: "user_decision",
      content: `User set proposed folder${finalPath ? ` "${finalPath}"` : ""} status to "${body.status}".`,
    });
  }
  return NextResponse.json({ ok: true });
}
