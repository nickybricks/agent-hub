import { NextResponse } from "next/server";
import { readFileSync } from "fs";
import { join } from "path";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { traceable } from "langsmith/traceable";
import { createLLM, LLMConfig } from "@/agent/summarize";
import { getDb, listMemories, touchMemoryUsed, AgentMemory } from "@/lib/analyzer-db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SYSTEM_PROMPT = `You are the user's email mailbox brain. You have access to:
- STATS: live aggregates from the mailbox database — totals, top mailboxes, category breakdown, the full list of proposed folders with rationales and rules, open audit findings with examples, and recent move batches. Use STATS as ground truth.
- MEMORIES: a timeline of LLM-generated and user-made decisions (proposal runs, accept/reject, applies, audit overrides, dismissals). Memories give context the STATS don't.

Answer the user's question concisely, in their language. Stick to what STATS and MEMORIES actually say. If something is not in the provided context, say so plainly — do not fabricate names, counts, or rationales.

When you rely on a specific memory, cite it inline with [m<id>] (e.g. "[m42]"). Do not invent memory ids. You do not need to cite STATS — they are always implicit ground truth.`;

function loadLLMConfig(): LLMConfig {
  const cfg = JSON.parse(readFileSync(join(process.cwd(), "data", "config.json"), "utf-8"));
  const agent = cfg.agents?.find((a: { id: string }) => a.id === "newsletter-summarizer");
  if (!agent?.settings?.llm) throw new Error("No LLM config in data/config.json");
  return { ...agent.settings.llm, systemPrompt: SYSTEM_PROMPT } as LLMConfig;
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

function gatherStats(): Stats {
  const db = getDb();
  const totalMessages = (db.prepare(`SELECT COUNT(*) AS c FROM messages`).get() as { c: number }).c;
  const totalSenders = (db.prepare(`SELECT COUNT(*) AS c FROM senders`).get() as { c: number }).c;
  const topMailboxes = db.prepare(
    `SELECT mb.name AS name, COUNT(*) AS count FROM messages m JOIN mailboxes mb ON m.mailbox_id = mb.id GROUP BY mb.name ORDER BY count DESC LIMIT 10`
  ).all() as { name: string; count: number }[];
  const categoryBreakdown = db.prepare(
    `SELECT COALESCE(category, 'unclassified') AS category, COUNT(*) AS count FROM senders GROUP BY category ORDER BY count DESC`
  ).all() as { category: string; count: number }[];
  const recentMoves = db.prepare(
    `SELECT batch_id, to_mailbox, COUNT(*) AS count, MAX(applied_at) AS applied_at
     FROM move_log WHERE status = 'applied'
     GROUP BY batch_id, to_mailbox
     ORDER BY applied_at DESC LIMIT 10`
  ).all() as { batch_id: string; to_mailbox: string; count: number; applied_at: string }[];
  const acceptedRules = (db.prepare(`SELECT COUNT(*) AS c FROM folder_rules WHERE status = 'accepted'`).get() as { c: number }).c;
  const rejectedRules = (db.prepare(`SELECT COUNT(*) AS c FROM folder_rules WHERE status = 'rejected'`).get() as { c: number }).c;
  const proposedFolders = (db.prepare(`SELECT COUNT(*) AS c FROM proposed_folders WHERE status = 'proposed'`).get() as { c: number }).c;
  const createdFolders = (db.prepare(`SELECT COUNT(*) AS c FROM proposed_folders WHERE status = 'created'`).get() as { c: number }).c;
  const auditFindingsOpen = (db.prepare(`SELECT COUNT(*) AS c FROM audit_findings WHERE dismissed_at IS NULL`).get() as { c: number }).c;

  const folders = db.prepare(
    `SELECT id, path, status, rationale FROM proposed_folders ORDER BY path`
  ).all() as { id: number; path: string; status: string; rationale: string | null }[];
  const rules = db.prepare(
    `SELECT target_folder, match_type, match_value, status, confidence FROM folder_rules WHERE source = 'llm_proposal'`
  ).all() as { target_folder: string | null; match_type: string; match_value: string; status: string; confidence: number | null }[];
  const rulesByFolder = new Map<string, ProposalDetail["rules"]>();
  for (const r of rules) {
    if (!r.target_folder) continue;
    const arr = rulesByFolder.get(r.target_folder) ?? [];
    arr.push({ match_type: r.match_type, match_value: r.match_value, status: r.status, confidence: r.confidence });
    rulesByFolder.set(r.target_folder, arr);
  }
  const proposals: ProposalDetail[] = folders.map((f) => ({
    id: f.id,
    path: f.path,
    status: f.status,
    rationale: f.rationale,
    rules: rulesByFolder.get(f.path) ?? [],
  }));

  const auditCounts = db.prepare(
    `SELECT kind, COUNT(*) AS count FROM audit_findings WHERE dismissed_at IS NULL GROUP BY kind`
  ).all() as { kind: string; count: number }[];
  const auditByKind: AuditDetail[] = auditCounts.map((row) => {
    const examples = db.prepare(
      `SELECT sender_email, reasoning FROM audit_findings WHERE kind = ? AND dismissed_at IS NULL ORDER BY score DESC LIMIT 3`
    ).all(row.kind) as { sender_email: string | null; reasoning: string | null }[];
    return {
      kind: row.kind,
      count: row.count,
      examples: examples.map((e) => `${e.sender_email ?? "(no sender)"}: ${e.reasoning ?? "(no reasoning)"}`),
    };
  });

  return {
    totalMessages, totalSenders, topMailboxes, categoryBreakdown,
    recentMoves, acceptedRules, rejectedRules, proposedFolders, createdFolders, auditFindingsOpen,
    proposals, auditByKind,
  };
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
  async () => {
    const memories = listMemories({ limit: 200 });
    const stats = gatherStats();
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
${renderStats(input.stats)}

MEMORIES (most recent first):
${memoryBlock}

QUESTION: ${input.question}`;
  },
  { name: "ask.build-prompt", run_type: "prompt" },
);

async function runAsk(question: string): Promise<{ answer: string; cited: AgentMemory[] }> {
  const { memories, stats } = await gatherContext();
  const userPrompt = await buildPrompt({ question, memories, stats });

  const config = loadLLMConfig();
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
  for (const m of cited) touchMemoryUsed(m.id);

  return { answer, cited };
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { question?: string } | null;
  const question = body?.question?.trim();
  if (!question) return NextResponse.json({ error: "question required" }, { status: 400 });

  try {
    const tracedAsk = traceable(runAsk, {
      name: "mail-analyzer.ask",
      run_type: "chain",
      tags: ["mail-analyzer", "ask"],
      metadata: { question_length: question.length },
    });
    const { answer, cited } = await tracedAsk(question);
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
