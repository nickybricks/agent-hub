import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { traceable } from "langsmith/traceable";
import { z } from "zod";
import { createLLM, LLMConfig } from "./summarize";
import type { SenderForProposal } from "../lib/analyzer-db";
import {
  getSendersForProposalPg,
  getProposalFolderRowsPg,
  getTopSendersForMailboxPg,
  getCategoryDistributionPg,
  getMailboxTotalsPg,
  insertProposedFoldersPg,
  insertFolderRulePg,
  setProposedFolderStatusPg,
  getProposedFolderByPathPg,
  clearPendingProposalsPg,
  writeMemoryPg,
  listMemoriesPg,
} from "../lib/analyzer-db-pg";
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

The user's existing folders are provided as context. STRONGLY prefer reusing an existing folder verbatim (exact same path/name) when one already covers a category — do not coin a synonym ("Housing" when "Real Estate" exists, "Parcels" when "Shopping/Orders" exists). Only rename or split when the existing name is genuinely unfit. This keeps re-runs stable and avoids near-duplicate folders. Do NOT touch system folders (INBOX, Sent, Drafts, Trash, Spam, Junk, Archive).

Group senders together; do not propose one folder per sender. For each folder, list the rules that route mail to it (sender_domain when many senders share a domain, sender_email for one-off important senders).
Skip generic categories like "Other" or "Misc". Skip senders that should stay in Inbox (personal mail, real humans).
Output only folders for non-Inbox routing.`;

// Default to Sonnet 4.6 — folder structure design benefits from a stronger reasoner
// than the Haiku used for per-sender classification.
const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-sonnet-4-6";

function defaultLLMConfig(): LLMConfig {
  return {
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    systemPrompt: withGuardrail(SYSTEM_PROMPT),
  };
}

function renderSender(s: SenderForProposal): string {
  return wrapEmail(`- ${s.email} (${s.domain}) — ${s.category ?? "unclassified"} — ${s.message_count} msgs — ${s.display_name ?? ""}`);
}

export async function runProposeStructure(
  userId: string,
  opts: { provider?: string; model?: string; minMessages?: number; limit?: number } = {},
) {
  const config = defaultLLMConfig();
  if (opts.provider) config.provider = opts.provider as LLMConfig["provider"];
  if (opts.model) config.model = opts.model;

  // Default to ALL senders meeting the min-messages threshold — Sonnet's context window
  // easily handles a few thousand entries, and folder design improves with full visibility.
  const minMessages = opts.minMessages ?? 3;
  const limit = opts.limit ?? 5000;
  const senders = await getSendersForProposalPg(userId, minMessages, limit);
  if (senders.length === 0) {
    console.log("No senders meet the threshold. Run mail:analyze + mail:classify first.");
    return;
  }

  // Existing folders with message counts + top senders per folder.
  const folderRows = await getProposalFolderRowsPg(userId);
  const existingMailboxes = folderRows.map((r) => r.name);
  const existingLower = new Set(existingMailboxes.map((n) => n.toLowerCase()));

  const folderContext = (
    await Promise.all(
      folderRows.map(async (f) => {
        const tops = await getTopSendersForMailboxPg(userId, f.id);
        const topStr = tops.length
          ? ` — top: ${tops.map((t) => `${t.sender_email} (${t.c})`).join(", ")}`
          : "";
        return `- ${f.name} (${f.msg_count.toLocaleString()} msgs)${topStr}`;
      })
    )
  ).join("\n");

  // Category distribution across all classified senders.
  const catRows = await getCategoryDistributionPg(userId);
  const catContext = catRows
    .map((c) => `- ${c.category}: ${c.msgs.toLocaleString()} messages from ${c.senders} senders`)
    .join("\n");

  // Overall totals.
  const totals = await getMailboxTotalsPg(userId);

  // Persona seam: let the synthesised user_profile + stated user_pref answers
  // shape the taxonomy so folders fit this specific person.
  const personaMemos = await listMemoriesPg(userId, { kind: "user_profile", limit: 1 });
  const prefMemos = await listMemoriesPg(userId, { kind: "user_pref", limit: 50 });
  const personaContext =
    personaMemos.length || prefMemos.length
      ? `User persona & stated preferences — design the structure to fit this person:
${personaMemos[0] ? `Persona: ${personaMemos[0].content}\n` : ""}${prefMemos.map((p) => `- ${p.content}`).join("\n")}

`
      : "";

  console.log(
    `Proposing structure from ${senders.length} senders using ${config.provider}/${config.model}… (${existingMailboxes.length} existing folders, ${totals.msgs.toLocaleString()} total messages)`
  );

  const userPrompt = `${personaContext}Mailbox snapshot:
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

  // Replace any prior un-acted proposal so a re-run (e.g. profile rebuild)
  // doesn't stack a second taxonomy on top of the first. Accepted/applied
  // rules and folders are preserved.
  await clearPendingProposalsPg(userId);

  const folderInputs = out.folders.map((f) => ({ path: f.path, rationale: f.rationale }));
  await insertProposedFoldersPg(userId, folderInputs);
  // Mark folders that already exist as 'created' so the UI surfaces that.
  let reused = 0;
  for (const f of folderInputs) {
    if (existingLower.has(f.path.toLowerCase())) {
      const row = await getProposedFolderByPathPg(userId, f.path);
      if (row && row.status === "proposed") {
        await setProposedFolderStatusPg(userId, row.id, "created");
        reused++;
      }
    }
  }
  console.log(`Inserted ${folderInputs.length} proposed folders (${reused} already exist).`);

  let ruleCount = 0;
  for (const f of out.folders) {
    for (const r of f.rules) {
      await insertFolderRulePg(userId, {
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

  await writeMemoryPg(userId, {
    kind: "proposal_run",
    source: "llm",
    content: `Proposed ${folderInputs.length} folders (${reused} already existed) and ${ruleCount} routing rules using ${config.provider}/${config.model}. Considered ${senders.length} senders and ${existingMailboxes.length} existing mailboxes.`,
  });
  for (const f of out.folders) {
    await writeMemoryPg(userId, {
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

async function main() {
  const args = process.argv.slice(2);
  const get = (p: string) => args.find((a) => a.startsWith(p))?.split("=")[1];

  const userId = process.env.DEV_USER_ID;
  if (!userId) {
    console.error("DEV_USER_ID env var required.");
    process.exit(1);
  }

  await runProposeStructure(userId, {
    provider: get("--provider="),
    model: get("--model="),
    minMessages: get("--min-messages=") ? Number(get("--min-messages=")) : undefined,
    limit: get("--limit=") ? Number(get("--limit=")) : undefined,
  });
}

if (require.main === module) {
  main()
    .then(async () => {
      await flushLangSmith();
      process.exit(0);
    })
    .catch(async (err: unknown) => {
      console.error(err);
      await flushLangSmith();
      process.exit(1);
    });
}
