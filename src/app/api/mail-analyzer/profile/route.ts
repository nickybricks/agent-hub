import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import type { AgentMemory } from "@/lib/analyzer-db";
import { listMemoriesPg, writeMemoryPg, supersedeMemoryPg } from "@/lib/analyzer-db-pg";
import { describeError } from "@/lib/errcause";

export const dynamic = "force-dynamic";

interface ProfilePayload {
  persona: AgentMemory | null;
  prefs: AgentMemory[];
  memories: AgentMemory[];
  activity: AgentMemory[];
}

// The proposal audit trail (raw routing-rule dumps) is not a "learning" about
// the user — keep it out of the readable sections and behind its own collapse.
const ACTIVITY_KINDS = new Set([
  "rule_rationale",
  "proposal_run",
  "apply_action",
  "audit_decision",
  "system",
]);

function shape(all: AgentMemory[]): ProfilePayload {
  const persona = all.find((m) => m.kind === "user_profile") ?? null;
  // Questionnaire = only the onboarding answers (user_pref keyed onboarding:*).
  const prefs = all.filter(
    (m) => m.kind === "user_pref" && (m.key ?? "").startsWith("onboarding:"),
  );
  // Genuine learnings: non-onboarding prefs, sender facts, recorded mistakes.
  const memories = all.filter(
    (m) =>
      (m.kind === "user_pref" && !(m.key ?? "").startsWith("onboarding:")) ||
      m.kind === "sender_fact" ||
      m.kind === "mistake",
  );
  const activity = all.filter((m) => ACTIVITY_KINDS.has(m.kind));
  return { persona, prefs, memories, activity };
}

export async function GET() {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(shape(await listMemoriesPg(auth.userId)));
  } catch (e) {
    console.error("profile route error", e);
    return NextResponse.json(
      { error: describeError(e), persona: null, prefs: [], memories: [], activity: [] },
      { status: 200 },
    );
  }
}

export async function PUT(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { content?: unknown };
  const personaContent = typeof body.content === "string" ? body.content.trim() : null;
  if (personaContent === null || personaContent.length === 0) {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }

  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = auth.userId;

  const prev = (await listMemoriesPg(userId, { kind: "user_profile" }))[0];
  const newId = await writeMemoryPg(userId, {
    kind: "user_profile",
    content: personaContent,
    source: "user_decision",
  });
  if (prev) await supersedeMemoryPg(userId, prev.id, newId);

  return NextResponse.json({ ok: true, persona_id: newId });
}
