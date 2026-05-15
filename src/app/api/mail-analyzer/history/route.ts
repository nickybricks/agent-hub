import { NextResponse } from "next/server";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { listRecentMovesPg } from "@/lib/analyzer-db-pg";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const limit = Math.min(Number(new URL(req.url).searchParams.get("limit") ?? "500"), 2000);
  if (isMultiTenant()) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ moves: [] }, { status: 401 });
    const moves = await listRecentMovesPg(user.id, limit);
    return NextResponse.json({ moves });
  }
  const { listRecentMoves } = await import("@/lib/analyzer-db");
  return NextResponse.json({ moves: listRecentMoves(limit) });
}
