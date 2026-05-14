import { readFileSync } from "fs";
import { join } from "path";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { traceable } from "langsmith/traceable";
import { z } from "zod";
import { createLLM, LLMConfig } from "./summarize";
import {
  getSendersForProposal,
  insertProposedFolders,
  insertFolderRule,
  setProposedFolderStatus,
  getProposedFolderByPath,
  getDb,
  SenderForProposal,
  writeMemory,
} from "../lib/analyzer-db";
import { withGuardrail, wrapEmail } from "../lib/prompt-safety";

const ProposalSchema = z.object({
  folders: z
    .array(
      z.object({
        path: z
          .string()
          .describe(
            "Folder path. Use '/' for nesting (e.g. 'Newsletters/Tech'). Do not start with '/'. Avoid system folder names (INBOX, Sent, Drafts, Trash, Spam, Junk, Archive)."
          ),
        rationale: z.string().describe("One short sentence explaining what belongs here."),
        rules: z
          .array(
            z.object({
              match_type: z.enum(["sender_email", "sender_domain"]),
              match_value: z.string().describe("Exact sender email OR exact domain like 'github.com'"),
              confidence: z.number().min(0).max(1),
            })
          )
          .describe("Routing rules that send mail to this folder. Prefer domain rules when many senders share a domain."),
      })
    )
    .min(1),
});

const SYSTEM_PROMPT = `You are designing a folder structure for an email account.
The user wants a small, sensible taxonomy — 5 to 12 top-level folders, with optional one-level nesting for high-volume categories (e.g. "Newsletters/Tech").

The user's existing folders are provided as context so you can see what's already there. You may keep, rename, split, merge, or replace them — propose what you think is the cleanest structure. Do NOT touch system folders (INBOX, Sent, Drafts, Trash, Spam, Junk, Archive).

Group senders together; do not propose one folder per sender. For each folder, list the rules that route mail to it (sender_domain when many senders share a domain, sender_email for one-off important senders).
Skip generic categories like "Other" or "Misc". Skip senders that should stay in Inbox (personal mail, real humans).
Output only folders for non-Inbox routing.`;

// Default to Sonnet 4.6 — folder structure design benefits from a stronger reasoner
// than the Haiku used for per-sender classification.
const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-sonnet-4-6";

function loadLLMConfig(): LLMConfig {
  const cfg = JSON.parse(readFileSync(join(process.cwd(), "data", "config.json"), "utf-8"));
  const agent = cfg.agents.find((a: { id: string }) => a.id === "newsletter-summarizer");
  if (!agent?.settings?.llm) throw new Error("No LLM config found in data/config.json");
  return {
    ...agent.settings.llm,
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    systemPrompt: withGuardrail(SYSTEM_PROMPT),
  } as LLMConfig;
}

function renderSender(s: SenderForProposal): string {
  return wrapEmail(`- ${s.email} (${s.domain}) — ${s.category ?? "unclassified"} — ${s.message_count} msgs — ${s.display_name ?? ""}`);
}

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const minArg = args.find((a) => a.startsWith("--min-messages="));
  const providerArg = args.find((a) => a.startsWith("--provider="));
  const modelArg = args.find((a) => a.startsWith("--model="));

  const config = loadLLMConfig();
  if (providerArg) config.provider = providerArg.split("=")[1] as LLMConfig["provider"];
  if (modelArg) config.model = modelArg.split("=")[1];

  // Default to ALL senders meeting the min-messages threshold — Sonnet's context window
  // easily handles a few thousand entries, and folder design improves with full visibility.
  const senders = getSendersForProposal(
    minArg ? Number(minArg.split("=")[1]) : 3,
    limitArg ? Number(limitArg.split("=")[1]) : 5000
  );
  if (senders.length === 0) {
    console.log("No senders meet the threshold. Run mail:analyze + mail:classify first.");
    return;
  }

  const db = getDb();

  // Existing folders with message counts + top senders per folder.
  const folderRows = db
    .prepare(
      `SELECT mb.id, mb.name, COUNT(m.id) AS msg_count
       FROM mailboxes mb
       LEFT JOIN messages m ON m.mailbox_id = mb.id
       GROUP BY mb.id
       ORDER BY msg_count DESC`
    )
    .all() as { id: number; name: string; msg_count: number }[];
  const existingMailboxes = folderRows.map((r) => r.name);
  const existingLower = new Set(existingMailboxes.map((n) => n.toLowerCase()));

  const topSendersStmt = db.prepare(
    `SELECT sender_email, COUNT(*) AS c
     FROM messages WHERE mailbox_id = ?
     GROUP BY LOWER(sender_email)
     ORDER BY c DESC LIMIT 3`
  );

  const folderContext = folderRows
    .map((f) => {
      const tops = topSendersStmt.all(f.id) as { sender_email: string; c: number }[];
      const topStr = tops.length
        ? ` — top: ${tops.map((t) => `${t.sender_email} (${t.c})`).join(", ")}`
        : "";
      return `- ${f.name} (${f.msg_count.toLocaleString()} msgs)${topStr}`;
    })
    .join("\n");

  // Category distribution across all classified senders.
  const catRows = db
    .prepare(
      `SELECT s.category, COUNT(DISTINCT s.email) AS senders, COUNT(m.id) AS msgs
       FROM senders s
       JOIN messages m ON LOWER(m.sender_email) = s.email
       WHERE s.category IS NOT NULL
       GROUP BY s.category
       ORDER BY msgs DESC`
    )
    .all() as { category: string; senders: number; msgs: number }[];
  const catContext = catRows
    .map((c) => `- ${c.category}: ${c.msgs.toLocaleString()} messages from ${c.senders} senders`)
    .join("\n");

  // Overall totals.
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS msgs, COUNT(DISTINCT sender_email) AS senders FROM messages`
    )
    .get() as { msgs: number; senders: number };

  console.log(
    `Proposing structure from ${senders.length} senders using ${config.provider}/${config.model}… (${existingMailboxes.length} existing folders, ${totals.msgs.toLocaleString()} total messages)`
  );

  const userPrompt = `Mailbox snapshot:
- ${totals.msgs.toLocaleString()} total messages from ${totals.senders.toLocaleString()} distinct senders
- ${existingMailboxes.length} existing folders

Current folder structure (with message counts and top senders) — keep, rename, split, merge, or replace as you see fit:
${wrapEmail(folderContext)}

Sender category distribution (from prior LLM classification):
${catContext}

Top ${senders.length} senders by volume (the senders the structure needs to handle):

${senders.map(renderSender).join("\n")}

Design the folder structure. You have the full picture: existing folders, where mail currently lives, what categories dominate, and which senders matter most. Output strictly the schema.`;

  const llm = createLLM(config);
  const structured = llm.withStructuredOutput(ProposalSchema, { name: "folder_proposal" });
  const invokeProposal = traceable(
    async (messages: { system: string; user: string }) => {
      return structured.invoke([
        new SystemMessage(messages.system),
        new HumanMessage(messages.user),
      ]);
    },
    {
      name: "propose-folder-structure",
      run_type: "chain",
      metadata: {
        provider: config.provider,
        model: config.model,
        sender_count: senders.length,
        existing_folder_count: existingMailboxes.length,
      },
    }
  );
  const out = await invokeProposal({ system: config.systemPrompt, user: userPrompt });

  const folderInputs = out.folders.map((f) => ({ path: f.path, rationale: f.rationale }));
  insertProposedFolders(folderInputs);
  // Mark folders that already exist as 'created' so the UI surfaces that.
  let reused = 0;
  for (const f of folderInputs) {
    if (existingLower.has(f.path.toLowerCase())) {
      const row = getProposedFolderByPath(f.path);
      if (row && row.status === "proposed") {
        setProposedFolderStatus(row.id, "created");
        reused++;
      }
    }
  }
  console.log(`Inserted ${folderInputs.length} proposed folders (${reused} already exist).`);

  let ruleCount = 0;
  for (const f of out.folders) {
    for (const r of f.rules) {
      insertFolderRule({
        match_type: r.match_type,
        match_value: r.match_value,
        action: "route_to",
        target_folder: f.path,
        source: "llm_proposal",
        confidence: r.confidence,
        status: "proposed",
      });
      ruleCount++;
    }
  }
  console.log(`Inserted ${ruleCount} proposed rules. Review at /mail-analyzer/proposals.`);

  writeMemory({
    kind: "proposal_run",
    source: "llm",
    content: `Proposed ${folderInputs.length} folders (${reused} already existed) and ${ruleCount} routing rules using ${config.provider}/${config.model}. Considered ${senders.length} senders and ${existingMailboxes.length} existing mailboxes.`,
  });
  for (const f of out.folders) {
    writeMemory({
      kind: "rule_rationale",
      key: f.path,
      source: "llm",
      content: `Folder "${f.path}" proposed: ${f.rationale}. Routes ${f.rules.length} rule(s): ${f.rules.map((r) => `${r.match_type}=${r.match_value}`).join(", ")}.`,
    });
  }
}

async function flushLangSmith() {
  try {
    const { RunTree } = await import("langsmith/run_trees");
    const client = RunTree.getSharedClient();
    await client.awaitPendingTraceBatches();
    await new Promise((r) => setTimeout(r, 500));
    await client.awaitPendingTraceBatches();
  } catch {
    // LangSmith not configured — no-op.
  }
}

main()
  .then(async () => {
    await flushLangSmith();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await flushLangSmith();
    process.exit(1);
  });
