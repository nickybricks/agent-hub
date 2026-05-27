import { NextResponse } from "next/server";
import { getRulesForFolderPg, getSampleSubjectsForRulePg } from "@/lib/analyzer-db-pg";
import { getAuthUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const folderName = decodeURIComponent(name);
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const rules = await getRulesForFolderPg(auth.userId, folderName);
    const samples = await Promise.all(
      rules.map(async (r) => ({
        ruleId: r.id,
        subjects: await getSampleSubjectsForRulePg(auth.userId, r, 5),
      })),
    );
    const samplesByRule = new Map(samples.map((s) => [s.ruleId, s.subjects]));
    return NextResponse.json({
      folder: folderName,
      rules: rules.map((r) => ({ ...r, samples: samplesByRule.get(r.id) ?? [] })),
    });
  } catch (e) {
    console.error("folder detail route error", e);
    return NextResponse.json({ error: "failed to load folder" }, { status: 500 });
  }
}
