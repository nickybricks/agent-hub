import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getTopSendersPg } from "@/lib/analyzer-db-pg";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const category = req.nextUrl.searchParams.get("category");
    const auth = await getAuthUser();
    if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    return NextResponse.json({ senders: await getTopSendersPg(auth.userId, category) });
  } catch {
    return NextResponse.json({ senders: [] });
  }
}
