import { NextResponse } from "next/server";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { previewRule, ApplyError } from "@/lib/apply-rule";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ruleId = Number(url.searchParams.get("ruleId"));
  if (!ruleId) return NextResponse.json({ error: "ruleId required" }, { status: 400 });

  let userId: string | null = null;
  if (isMultiTenant()) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    userId = user.id;
  }

  try {
    const { rule, total, groups } = await previewRule(userId, ruleId);
    return NextResponse.json({ rule, total, groups });
  } catch (err) {
    if (err instanceof ApplyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
