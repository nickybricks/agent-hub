import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { runSpamRescan } from "@/agent/spam-rescan";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST() {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const result = await runSpamRescan(auth.userId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
