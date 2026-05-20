/**
 * Proactive returning-user greeting. When an already-onboarded user opens /app,
 * we compute what changed since their last visit (auto-filed mail, new folder
 * proposals, newly seen/classified senders, items waiting on them) and, only if
 * there's something worth saying, have a cheap model phrase it as a warm
 * companion check-in. Silent when nothing is new. Postgres / multi-tenant only.
 *
 * "Last visit" is a single superseding `system / last_seen` memory — kept out of
 * the user_pref + onboarding lists on purpose.
 */

import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { sql } from "drizzle-orm";
import { getDrizzleDb } from "./db";
import { createLLM } from "@/agent/summarize";
import { onboardingState } from "./chat-agent";
import { listMemoriesPg, writeMemoryPg, supersedeMemoryPg } from "./analyzer-db-pg";

const GREETING_SYSTEM = `You are the user's email mailbox agent, greeting them as they return.

Write a warm, brief "welcome back" — 2 to 4 sentences, like a thoughtful companion who has been keeping an eye on things, NOT a status report. Use the facts below; never invent any. Mention only what actually changed. If new senders appeared, name one and ask whether it's someone they expect or want handled. End with ONE concrete, inviting question that points at the most useful next step.

No bullet lists, no headings, no preamble. Plain conversational text in the user's language (infer it from their persona; default English).`;

interface Signals {
  triageCount: number;
  triageFolders: string[];
  newProposals: number;
  proposalPaths: string[];
  newSenders: number;
  senderSamples: string[];
  newPending: number;
  pendingTotal: number;
  newReview: number;
  reviewTotal: number;
}

function num(v: unknown): number {
  return Number((v as { c?: number })?.c ?? 0);
}

async function gatherSignals(userId: string, since: string): Promise<Signals> {
  const db = getDrizzleDb();

  const [triage] = await db.execute(sql`
    SELECT COUNT(*) AS c FROM move_log
    WHERE user_id = ${userId} AND status = 'applied'
      AND undone_at IS NULL AND applied_at > ${since}`);
  const triageFolderRows = await db.execute(sql`
    SELECT to_mailbox, COUNT(*) AS c FROM move_log
    WHERE user_id = ${userId} AND status = 'applied'
      AND undone_at IS NULL AND applied_at > ${since}
    GROUP BY to_mailbox ORDER BY c DESC LIMIT 3`);

  const [proposals] = await db.execute(sql`
    SELECT COUNT(*) AS c FROM proposed_folders
    WHERE user_id = ${userId} AND status = 'proposed' AND created_at > ${since}`);
  const proposalRows = await db.execute(sql`
    SELECT path FROM proposed_folders
    WHERE user_id = ${userId} AND status = 'proposed' AND created_at > ${since}
    ORDER BY created_at DESC LIMIT 4`);

  const [senders] = await db.execute(sql`
    SELECT COUNT(*) AS c FROM senders
    WHERE user_id = ${userId} AND classified_at IS NOT NULL AND classified_at > ${since}`);
  const senderRows = await db.execute(sql`
    SELECT email, display_name, category FROM senders
    WHERE user_id = ${userId} AND classified_at IS NOT NULL AND classified_at > ${since}
    ORDER BY classified_at DESC LIMIT 5`);

  const [pendingNew] = await db.execute(sql`
    SELECT COUNT(*) AS c FROM tool_calls
    WHERE user_id = ${userId} AND status = 'pending' AND created_at > ${since}`);
  const [pendingAll] = await db.execute(sql`
    SELECT COUNT(*) AS c FROM tool_calls
    WHERE user_id = ${userId} AND status = 'pending'`);

  const [reviewNew] = await db.execute(sql`
    SELECT COUNT(*) AS c FROM review_queue
    WHERE user_id = ${userId} AND status = 'pending' AND created_at > ${since}`);
  const [reviewAll] = await db.execute(sql`
    SELECT COUNT(*) AS c FROM review_queue
    WHERE user_id = ${userId} AND status = 'pending'`);

  return {
    triageCount: num(triage),
    triageFolders: (triageFolderRows as unknown as { to_mailbox: string }[]).map((r) => r.to_mailbox),
    newProposals: num(proposals),
    proposalPaths: (proposalRows as unknown as { path: string }[]).map((r) => r.path),
    newSenders: num(senders),
    senderSamples: (
      senderRows as unknown as { email: string; display_name: string | null; category: string | null }[]
    ).map(
      (r) => `${r.display_name || r.email}${r.category ? ` [${r.category}]` : ""}`,
    ),
    newPending: num(pendingNew),
    pendingTotal: num(pendingAll),
    newReview: num(reviewNew),
    reviewTotal: num(reviewAll),
  };
}

function isNewsworthy(s: Signals): boolean {
  return (
    s.triageCount > 0 ||
    s.newProposals > 0 ||
    s.newSenders > 0 ||
    s.newPending > 0 ||
    s.newReview > 0
  );
}

/**
 * Returns a phrased greeting, or null when there's nothing new to say (or the
 * user is still onboarding). `last_seen` is advanced on every call that gets
 * past the onboarding gate — including the silent ones — so a quiet visit
 * doesn't make the next visit re-report stale activity.
 */
export async function buildGreeting(userId: string): Promise<{ message: string } | null> {
  const onb = await onboardingState(userId);
  if (onb.active) return null; // onboarding flow owns the chat

  // First-run gate: the user has confirmed their persona (onboarding "done")
  // but the `proposing` Inngest job may still be running. Without this gate
  // the greeting fires with "you have 3,600 new senders" right after persona
  // confirm, because the just-classified mailbox looks like a huge delta vs
  // an empty `last_seen`. Skip until at least one proposal exists, AND skip
  // entirely on the very first visit (no prior `last_seen` memory).
  const prevRows = await listMemoriesPg(userId, { kind: "system", key: "last_seen", limit: 1 });
  if (prevRows.length === 0) {
    // Seed last_seen quietly so the *next* visit can compute real deltas.
    await writeMemoryPg(userId, {
      kind: "system",
      key: "last_seen",
      content: new Date().toISOString(),
      source: "self",
    });
    return null;
  }
  const [propCount] = await getDrizzleDb().execute(sql`
    SELECT COUNT(*) AS c FROM proposed_folders WHERE user_id = ${userId}
  `);
  if (Number((propCount as { c?: number })?.c ?? 0) === 0) return null;

  const prev = prevRows[0].content;

  const signals = await gatherSignals(userId, prev);

  // Advance the watermark regardless (quiet visits included).
  const newId = await writeMemoryPg(userId, {
    kind: "system",
    key: "last_seen",
    content: new Date().toISOString(),
    source: "self",
  });
  if (prevRows[0]) await supersedeMemoryPg(userId, prevRows[0].id, newId);

  if (!isNewsworthy(signals)) return null;

  const persona = (await listMemoriesPg(userId, { kind: "user_profile", limit: 1 }))[0]?.content;

  const facts: string[] = [];
  if (signals.triageCount > 0) {
    facts.push(
      `- ${signals.triageCount} message(s) were auto-filed${
        signals.triageFolders.length ? ` (into ${signals.triageFolders.join(", ")})` : ""
      }.`,
    );
  }
  if (signals.newProposals > 0) {
    facts.push(
      `- ${signals.newProposals} new folder proposal(s) are waiting on the Proposals tab${
        signals.proposalPaths.length ? `: ${signals.proposalPaths.join(", ")}` : ""
      }.`,
    );
  }
  if (signals.newSenders > 0) {
    facts.push(
      `- ${signals.newSenders} new sender(s) showed up and were classified${
        signals.senderSamples.length ? `, e.g. ${signals.senderSamples.join("; ")}` : ""
      }.`,
    );
  }
  if (signals.newReview > 0) {
    facts.push(
      `- ${signals.newReview} new item(s) need your review (${signals.reviewTotal} pending in total).`,
    );
  }
  if (signals.newPending > 0) {
    facts.push(
      `- ${signals.newPending} action(s) are waiting for your confirmation in chat (${signals.pendingTotal} pending in total).`,
    );
  }

  const userPrompt = `${persona ? `Who they are:\n${persona}\n\n` : ""}What changed since their last visit:
${facts.join("\n")}`;

  const llm = createLLM({
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    systemPrompt: GREETING_SYSTEM,
  });
  const res = await llm.invoke(
    [new SystemMessage(GREETING_SYSTEM), new HumanMessage(userPrompt)],
    { tags: ["mail-analyzer", "greeting"] },
  );
  const text = (typeof res.content === "string" ? res.content : String(res.content)).trim();
  return text ? { message: text } : null;
}
