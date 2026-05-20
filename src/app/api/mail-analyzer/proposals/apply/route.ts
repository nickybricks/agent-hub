import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { applyRule, ApplyError } from "@/lib/apply-rule";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const body = (await req.json()) as { ruleId: number; makeRule?: boolean };
  if (!body.ruleId) return NextResponse.json({ error: "ruleId required" }, { status: 400 });

  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = auth.userId;

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
