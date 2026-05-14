import { NextResponse } from "next/server";
import {
  setProposedFolderStatus,
  updateProposedFolderPath,
  ProposedFolderStatus,
} from "@/lib/analyzer-db";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const folderId = Number(id);
  const body = (await req.json()) as { status?: ProposedFolderStatus; path?: string };
  if (body.path) updateProposedFolderPath(folderId, body.path);
  if (body.status) setProposedFolderStatus(folderId, body.status);
  return NextResponse.json({ ok: true });
}
