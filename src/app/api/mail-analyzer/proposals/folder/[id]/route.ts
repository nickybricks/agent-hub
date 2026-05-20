import { NextResponse } from "next/server";
import type { ProposedFolderStatus } from "@/lib/analyzer-db";
import {
  setProposedFolderStatusPg,
  updateProposedFolderPathPg,
  getProposedFolderByIdPg,
  writeMemoryPg,
} from "@/lib/analyzer-db-pg";
import { getAuthUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const folderId = Number(id);
  const body = (await req.json()) as { status?: ProposedFolderStatus; path?: string };

  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = auth.userId;

  const before = await getProposedFolderByIdPg(userId, folderId);
  if (body.path) await updateProposedFolderPathPg(userId, folderId, body.path);
  if (body.status) await setProposedFolderStatusPg(userId, folderId, body.status);

  const finalPath = body.path ?? before?.path ?? null;
  if (body.path && before && before.path !== body.path) {
    await writeMemoryPg(userId, {
      kind: "user_pref",
      key: body.path,
      source: "user_decision",
      content: `User renamed proposed folder "${before.path}" to "${body.path}".`,
    });
  }
  if (body.status) {
    await writeMemoryPg(userId, {
      kind: "user_pref",
      key: finalPath,
      source: "user_decision",
      content: `User set proposed folder${finalPath ? ` "${finalPath}"` : ""} status to "${body.status}".`,
    });
  }
  return NextResponse.json({ ok: true });
}
