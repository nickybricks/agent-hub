import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getCategoryRollupPg } from "@/lib/analyzer-db-pg";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const auth = await getAuthUser();
    if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    return NextResponse.json({ categories: await getCategoryRollupPg(auth.userId) });
  } catch {
    return NextResponse.json({ categories: [] });
  }
}
