import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getVolumeByDayPg } from "@/lib/analyzer-db-pg";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const auth = await getAuthUser();
    if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    return NextResponse.json({ rows: await getVolumeByDayPg(auth.userId) });
  } catch {
    return NextResponse.json({ rows: [] });
  }
}
