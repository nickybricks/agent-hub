import { NextResponse } from "next/server";
import { insertFolderRulePg, writeMemoryPg } from "@/lib/analyzer-db-pg";
import { getAuthUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const folderName = decodeURIComponent(name);
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json()) as {
    match_type?: "sender_email" | "sender_domain";
    match_value?: string;
    confidence?: number | null;
  };
  if (!body.match_type || !body.match_value) {
    return NextResponse.json({ error: "match_type and match_value are required" }, { status: 400 });
  }
  if (body.match_type !== "sender_email" && body.match_type !== "sender_domain") {
    return NextResponse.json({ error: "invalid match_type" }, { status: 400 });
  }

  const id = await insertFolderRulePg(auth.userId, {
    match_type: body.match_type,
    match_value: body.match_value.trim(),
    action: "route_to",
    target_folder: folderName,
    source: "user",
    status: "accepted",
    confidence: body.confidence ?? null,
  });
  await writeMemoryPg(auth.userId, {
    kind: "user_pref",
    key: folderName,
    source: "user_decision",
    content: `User added rule (${body.match_type}=${body.match_value} → ${folderName}).`,
  });
  return NextResponse.json({ ok: true, id });
}
