import { NextResponse } from "next/server";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import type { AgentMemory } from "@/lib/analyzer-db";

export const dynamic = "force-dynamic";

interface ProfilePayload {
  persona: AgentMemory | null;
  prefs: AgentMemory[];
  memories: AgentMemory[];
}

function shape(all: AgentMemory[]): ProfilePayload {
  const persona = all.find((m) => m.kind === "user_profile") ?? null;
  const prefs = all.filter((m) => m.kind === "user_pref");
  const memories = all.filter((m) => m.kind !== "user_profile" && m.kind !== "user_pref");
  return { persona, prefs, memories };
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
  const { listMemoriesPg } = await import("@/lib/analyzer-db-pg");
  return NextResponse.json(shape(await listMemoriesPg(userId)));
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
