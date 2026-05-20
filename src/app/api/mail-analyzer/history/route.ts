import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { listRecentMovesPg } from "@/lib/analyzer-db-pg";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const limit = Math.min(Number(new URL(req.url).searchParams.get("limit") ?? "500"), 2000);
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ moves: [] }, { status: 401 });
  const moves = await listRecentMovesPg(auth.userId, limit);
  return NextResponse.json({ moves });
}
