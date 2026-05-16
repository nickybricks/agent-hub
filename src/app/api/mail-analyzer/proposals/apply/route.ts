import { NextResponse } from "next/server";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { applyRule, ApplyError } from "@/lib/apply-rule";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const body = (await req.json()) as { ruleId: number; makeRule?: boolean };
  if (!body.ruleId) return NextResponse.json({ error: "ruleId required" }, { status: 400 });

  let userId: string | null = null;
  if (isMultiTenant()) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    userId = user.id;
  }

  try {
    const { moved, failed, batch_id } = await applyRule(userId, body.ruleId, body.makeRule !== false);
    return NextResponse.json({ ok: true, moved, failed, batch_id });
  } catch (err) {
    if (err instanceof ApplyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
