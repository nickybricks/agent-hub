import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { previewRule, ApplyError } from "@/lib/apply-rule";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ruleId = Number(url.searchParams.get("ruleId"));
  if (!ruleId) return NextResponse.json({ error: "ruleId required" }, { status: 400 });

  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const { rule, total, groups } = await previewRule(auth.userId, ruleId);
    return NextResponse.json({ rule, total, groups });
  } catch (err) {
    if (err instanceof ApplyError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
}
