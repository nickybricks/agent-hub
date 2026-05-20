import { NextResponse } from "next/server";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { traceable } from "langsmith/traceable";
import { createLLM, LLMConfig } from "@/agent/summarize";
import type { AgentMemory } from "@/lib/analyzer-db";
import { listMemoriesPg, touchMemoryUsedPg, gatherAskStatsPg } from "@/lib/analyzer-db-pg";
import { getAuthUser } from "@/lib/auth";
import { withGuardrail, wrapEmail } from "@/lib/prompt-safety";
import { checkRateLimit, ipFromRequest } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SYSTEM_PROMPT = `You are the user's email mailbox brain. You have access to:
- STATS: live aggregates from the mailbox database — totals, top mailboxes, category breakdown, the full list of proposed folders with rationales and rules, open audit findings with examples, and recent move batches. Use STATS as ground truth.
- MEMORIES: a timeline of LLM-generated and user-made decisions (proposal runs, accept/reject, applies, audit overrides, dismissals). Memories give context the STATS don't.

Answer the user's question concisely, in their language. Stick to what STATS and MEMORIES actually say. If something is not in the provided context, say so plainly — do not fabricate names, counts, or rationales.

When you rely on a specific memory, cite it inline with [m<id>] (e.g. "[m42]"). Do not invent memory ids. You do not need to cite STATS — they are always implicit ground truth.`;

function defaultLLMConfig(): LLMConfig {
  const provider = process.env.ANTHROPIC_API_KEY ? "anthropic" : "openai";
  const model = provider === "anthropic" ? "claude-sonnet-4-6" : "gpt-4o-mini";
  return { provider, model, systemPrompt: withGuardrail(SYSTEM_PROMPT) };
}

function renderMemory(m: AgentMemory): string {
  const when = m.created_at.slice(0, 10);
  const key = m.key ? ` key="${m.key}"` : "";
  return `[m${m.id}] ${when} kind=${m.kind} source=${m.source}${key}: ${m.content}`;
}

interface ProposalDetail {
  id: number;
  path: string;
  status: string;
  rationale: string | null;
  rules: { match_type: string; match_value: string; status: string; confidence: number | null }[];
}

interface AuditDetail {
  kind: string;
  count: number;
  examples: string[];
}

interface Stats {
  totalMessages: number;
  totalSenders: number;
  topMailboxes: { name: string; count: number }[];
  categoryBreakdown: { category: string; count: number }[];
  recentMoves: { batch_id: string; to_mailbox: string; count: number; applied_at: string }[];
  acceptedRules: number;
  rejectedRules: number;
  proposedFolders: number;
  createdFolders: number;
  auditFindingsOpen: number;
  proposals: ProposalDetail[];
  auditByKind: AuditDetail[];
}

function renderStats(s: Stats): string {
  const lines: string[] = [
    `Total messages: ${s.totalMessages}`,
    `Total senders: ${s.totalSenders}`,
    `Top mailboxes: ${s.topMailboxes.map((m) => `${m.name}(${m.count})`).join(", ")}`,
    `Category breakdown: ${s.categoryBreakdown.map((c) => `${c.category}(${c.count})`).join(", ")}`,
    `Folder rules summary: ${s.acceptedRules} accepted, ${s.rejectedRules} rejected`,
    `Proposed folders summary: ${s.proposedFolders} pending, ${s.createdFolders} created`,
    `Open audit findings: ${s.auditFindingsOpen}`,
  ];

  if (s.proposals.length > 0) {
    lines.push("", "Proposed folders (detailed):");
    for (const p of s.proposals) {
      lines.push(`  - "${p.path}" [status=${p.status}]: ${p.rationale ?? "(no rationale stored)"}`);
      for (const r of p.rules) {
        lines.push(`      rule: ${r.match_type}=${r.match_value} [status=${r.status}]${r.confidence != null ? ` confidence=${r.confidence.toFixed(2)}` : ""}`);
      }
    }
  }

  if (s.auditByKind.length > 0) {
    lines.push("", "Audit findings by kind (top examples):");
    for (const a of s.auditByKind) {
      lines.push(`  - ${a.kind}: ${a.count} open`);
      for (const ex of a.examples) lines.push(`      • ${ex}`);
    }
  }

  if (s.recentMoves.length > 0) {
    lines.push("", "Recent move batches:");
    for (const m of s.recentMoves) {
      lines.push(`  - ${m.applied_at.slice(0, 16)} → ${m.to_mailbox} (${m.count} messages, batch ${m.batch_id.slice(0, 8)})`);
    }
  }

  return lines.join("\n");
}

function extractCitedIds(text: string): number[] {
  const ids = new Set<number>();
  for (const match of text.matchAll(/\[m(\d+)\]/g)) {
    ids.add(Number(match[1]));
  }
  return [...ids];
}

const gatherContext = traceable(
  async (userId: string) => {
    const memories = await listMemoriesPg(userId, { limit: 200 });
    const stats = await gatherAskStatsPg(userId);
    return { memories, stats };
  },
  { name: "ask.gather-context", run_type: "tool" },
);

const buildPrompt = traceable(
  async (input: { question: string; memories: AgentMemory[]; stats: Stats }) => {
    const memoryBlock = input.memories.length
      ? input.memories.map(renderMemory).join("\n")
      : "(no memories recorded yet)";
    return `STATS:
${wrapEmail(renderStats(input.stats))}

MEMORIES (most recent first):
${wrapEmail(memoryBlock)}

QUESTION: ${input.question}`;
  },
  { name: "ask.build-prompt", run_type: "prompt" },
);

async function runAsk(
  question: string,
  userId: string,
): Promise<{ answer: string; cited: AgentMemory[] }> {
  const { memories, stats } = await gatherContext(userId);
  const userPrompt = await buildPrompt({ question, memories, stats });

  const config = defaultLLMConfig();
  const llm = createLLM(config);
  const callLLM = traceable(
    async () => {
      return llm.invoke(
        [new SystemMessage(config.systemPrompt), new HumanMessage(userPrompt)],
        { tags: ["mail-analyzer", "ask", `provider:${config.provider}`, `model:${config.model}`] },
      );
    },
    {
      name: "ask.llm-call",
      run_type: "llm",
      tags: ["mail-analyzer", "ask"],
      metadata: { provider: config.provider, model: config.model },
    },
  );
  const result = await callLLM();
  const answer = typeof result.content === "string"
    ? result.content
    : result.content.map((c) => ("text" in c ? c.text : "")).join("");

  const citedIds = extractCitedIds(answer);
  const memoryById = new Map(memories.map((m) => [m.id, m]));
  const cited = citedIds.map((id) => memoryById.get(id)).filter((m): m is AgentMemory => !!m);
  for (const m of cited) await touchMemoryUsedPg(userId, m.id);

  return { answer, cited };
}

export async function POST(req: Request) {
  const rl = await checkRateLimit(`ask:${ipFromRequest(req)}`, 10, 60);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many requests", retryAfter: rl.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const body = (await req.json().catch(() => null)) as { question?: string } | null;
  const question = body?.question?.trim();
  if (!question) return NextResponse.json({ error: "question required" }, { status: 400 });

  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const tracedAsk = traceable(runAsk, {
      name: "mail-analyzer.ask",
      run_type: "chain",
      tags: ["mail-analyzer", "ask"],
      metadata: { question_length: question.length },
    });
    const { answer, cited } = await tracedAsk(question, auth.userId);
    return NextResponse.json({
      answer,
      cited_memories: cited.map((m) => ({
        id: m.id,
        kind: m.kind,
        key: m.key,
        content: m.content,
        created_at: m.created_at,
        source: m.source,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "LLM failed" },
      { status: 500 },
    );
  }
}
