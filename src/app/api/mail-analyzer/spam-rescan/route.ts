import { NextResponse } from "next/server";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { runSpamRescan } from "@/agent/spam-rescan";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST() {
  if (isMultiTenant()) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    // Background-job path: runSpamRescan reads DEV_USER_ID for now. When per-user
    // auth-driven runs are wired up, replace the env read with `user.id`.
  }

  try {
    const result = await runSpamRescan();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
