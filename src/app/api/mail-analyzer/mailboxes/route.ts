import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { listMailboxesPg } from "@/lib/analyzer-db-pg";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const auth = await getAuthUser();
    if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    return NextResponse.json({ mailboxes: await listMailboxesPg(auth.userId) });
  } catch {
    return NextResponse.json({ mailboxes: [] });
  }
}
