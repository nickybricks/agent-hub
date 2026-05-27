import { NextResponse } from "next/server";
import { listFolderTreePg } from "@/lib/analyzer-db-pg";
import { getAuthUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const folders = await listFolderTreePg(auth.userId);
    return NextResponse.json({ folders });
  } catch (e) {
    console.error("folders route error", e);
    return NextResponse.json({ error: "failed to load folders" }, { status: 500 });
  }
}
