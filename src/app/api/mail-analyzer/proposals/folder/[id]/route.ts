import { NextResponse } from "next/server";
import {
  setProposedFolderStatus,
  updateProposedFolderPath,
  ProposedFolderStatus,
  writeMemory,
  getDb,
} from "@/lib/analyzer-db";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const folderId = Number(id);
  const body = (await req.json()) as { status?: ProposedFolderStatus; path?: string };
  const before = getDb().prepare(`SELECT path FROM proposed_folders WHERE id = ?`).get(folderId) as { path: string } | undefined;
  if (body.path) updateProposedFolderPath(folderId, body.path);
  if (body.status) setProposedFolderStatus(folderId, body.status);
  const finalPath = body.path ?? before?.path ?? null;
  if (body.path && before && before.path !== body.path) {
    writeMemory({
      kind: "user_pref",
      key: body.path,
      source: "user_decision",
      content: `User renamed proposed folder "${before.path}" to "${body.path}".`,
    });
  }
  if (body.status) {
    writeMemory({
      kind: "user_pref",
      key: finalPath,
      source: "user_decision",
      content: `User set proposed folder${finalPath ? ` "${finalPath}"` : ""} status to "${body.status}".`,
    });
  }
  return NextResponse.json({ ok: true });
}
