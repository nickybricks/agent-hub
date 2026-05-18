import { NextResponse } from "next/server";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import type { AgentMemory } from "@/lib/analyzer-db";
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

// ── SQLite (local dev) ───────────────────────────────────────────────────────

async function getSqlite() {
  const { listMemories } = await import("@/lib/analyzer-db");
  return NextResponse.json(shape(listMemories()));
}

async function putSqlite(content: string) {
  const { listMemories, writeMemory, supersedeMemory } = await import("@/lib/analyzer-db");
  const prev = listMemories({ kind: "user_profile" }).find((m) => m.kind === "user_profile");
  const newId = writeMemory({ kind: "user_profile", content, source: "user_decision" });
  if (prev) supersedeMemory(prev.id, newId);
  return NextResponse.json({ ok: true, id: newId });
}

// ── Postgres (multi-tenant) ──────────────────────────────────────────────────

async function authedUserId() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  return error || !user ? null : user.id;
}

async function getMultiTenant() {
  const userId = await authedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const { listMemoriesPg } = await import("@/lib/analyzer-db-pg");
    return NextResponse.json(shape(await listMemoriesPg(userId)));
  } catch (e) {
    console.error("profile route error", e);
    return NextResponse.json(
      { error: describeError(e), persona: null, prefs: [], memories: [], activity: [] },
      { status: 200 },
    );
  }
}

async function putMultiTenant(content: string) {
  const userId = await authedUserId();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { listMemoriesPg, writeMemoryPg, supersedeMemoryPg } = await import(
    "@/lib/analyzer-db-pg"
  );
  const prev = (await listMemoriesPg(userId, { kind: "user_profile" }))[0];
  const newId = await writeMemoryPg(userId, {
    kind: "user_profile",
    content,
    source: "user_decision",
  });
  if (prev) await supersedeMemoryPg(userId, prev.id, newId);
  return NextResponse.json({ ok: true, id: newId });
}

// ── handlers ─────────────────────────────────────────────────────────────────

export async function GET() {
  return isMultiTenant() ? getMultiTenant() : getSqlite();
}

export async function PUT(req: Request) {
  let content: unknown;
  try {
    content = (await req.json())?.content;
  } catch {
    content = undefined;
  }
  if (typeof content !== "string" || !content.trim()) {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  return isMultiTenant() ? putMultiTenant(content.trim()) : putSqlite(content.trim());
}
