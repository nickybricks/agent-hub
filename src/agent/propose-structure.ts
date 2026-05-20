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
  clearPendingProposalsPg,
  writeMemoryPg,
  listMemoriesPg,
  deleteMemoriesByKindPg,
} from "../lib/analyzer-db-pg";
import { withGuardrail, wrapEmail } from "../lib/prompt-safety";

const FolderSchema = z.object({
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
    .describe(
      "Routing rules that send mail to this folder. Prefer domain rules when many senders share a domain."
    ),
});

const ProposalSchema = z.object({
  folders: z.array(FolderSchema).min(1),
});

type ProposedFolder = z.infer<typeof FolderSchema>;

// Streaming parser: feeds chunks of the tool-call args JSON and yields each
// completed `folders[]` element (as a JSON substring) the moment its closing
// `}` arrives. Strings are tracked so a `}` inside a string doesn't fool depth.
class FolderStreamParser {
  private buf = "";
  private pos = 0;
  private state: "before_array" | "in_array" = "before_array";
  private depth = 0;
  private folderStart = -1;
  private inString = false;
  private escape = false;

  feed(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    while (this.pos < this.buf.length) {
      if (this.state === "before_array") {
        const folderIdx = this.buf.indexOf('"folders"', this.pos);
        if (folderIdx === -1) break; // wait for more bytes
        const bracketIdx = this.buf.indexOf("[", folderIdx);
        if (bracketIdx === -1) break; // wait for more bytes
        this.pos = bracketIdx + 1;
        this.state = "in_array";
        continue;
      }
      const c = this.buf[this.pos];
      if (this.inString) {
        if (this.escape) this.escape = false;
        else if (c === "\\") this.escape = true;
        else if (c === '"') this.inString = false;
        this.pos++;
        continue;
      }
      if (c === '"') {
        this.inString = true;
        this.pos++;
        continue;
      }
      if (c === "{") {
        if (this.depth === 0) this.folderStart = this.pos;
        this.depth++;
        this.pos++;
        continue;
      }
      if (c === "}") {
        this.depth--;
        this.pos++;
        if (this.depth === 0 && this.folderStart !== -1) {
          out.push(this.buf.slice(this.folderStart, this.pos));
          this.folderStart = -1;
        }
        continue;
      }
      this.pos++;
    }
    return out;
  }
}

const SYSTEM_PROMPT_BASE = `You are designing a folder structure for an email account.
The user wants a small, sensible taxonomy — 5 to 12 top-level folders, with optional one-level nesting for high-volume categories (e.g. "Newsletters/Tech").

The user's existing folders are provided as context. Do NOT touch system folders (INBOX, Sent, Drafts, Trash, Spam, Junk, Archive).

Group senders together; do not propose one folder per sender. For each folder, list the rules that route mail to it (sender_domain when many senders share a domain, sender_email for one-off important senders).
Skip generic categories like "Other" or "Misc". Skip senders that should stay in Inbox (personal mail, real humans).
Output only folders for non-Inbox routing.`;

const STRATEGY_GUIDANCE: Record<string, string> = {
  keep_augment:
    "The user wants to KEEP their existing folder structure and just fill gaps. Reuse existing folder paths verbatim (exact same name) wherever one already fits a category. Only add new folders for categories the existing structure doesn't cover. Do not rename or split existing folders.",
  simplify:
    "The user wants to SIMPLIFY their mailbox into a handful of clear folders. Collapse near-duplicates from the existing structure into broader categories. Aim for the lower end of 5–12 folders. You may reuse an existing folder name when it cleanly fits a consolidated category, but you are NOT required to keep them.",
  fresh_start:
    "The user wants a FRESH structure designed from scratch. Ignore the existing folder names — they came here precisely to replace them. Design the taxonomy purely from the sender data and the user's persona. Do not feel obligated to reuse existing folder names; coin clearer ones when warranted.",
};

function buildSystemPrompt(strategy: string | null): string {
  const guidance = strategy ? STRATEGY_GUIDANCE[strategy] : null;
  return guidance ? `${SYSTEM_PROMPT_BASE}\n\nFolder strategy chosen by the user: ${guidance}` : SYSTEM_PROMPT_BASE;
}

// Default to Sonnet 4.6 — folder structure design benefits from a stronger reasoner
// than the Haiku used for per-sender classification.
const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-sonnet-4-6";

function defaultLLMConfig(strategy: string | null): LLMConfig {
  return {
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    systemPrompt: withGuardrail(buildSystemPrompt(strategy)),
  };
}

function renderSender(s: SenderForProposal): string {
  return wrapEmail(`- ${s.email} (${s.domain}) — ${s.category ?? "unclassified"} — ${s.message_count} msgs — ${s.display_name ?? ""}`);
}

export async function runProposeStructure(
  userId: string,
  opts: { provider?: string; model?: string; minMessages?: number; limit?: number } = {},
) {
  // User's chosen folder strategy from onboarding (keep_augment | simplify |
  // fresh_start). Shapes the system prompt; null = no preference saved yet.
  const strategyPrefs = await listMemoriesPg(userId, {
    kind: "user_pref",
    key: "onboarding:folder_strategy",
    limit: 1,
  });
  const folderStrategy = strategyPrefs[0]?.content?.trim() || null;
  const config = defaultLLMConfig(folderStrategy);
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

  // Replace any prior un-acted proposal BEFORE the stream starts so partial
  // inserts from a previous (possibly mid-stream-aborted) run don't pile up.
  // Also drop the prior `proposal_run` marker — the pipeline route uses it as
  // the "streaming is finished" signal, and a stale marker would make the
  // current proposing phase look already-done on the very first poll.
  await clearPendingProposalsPg(userId);
  await deleteMemoriesByKindPg(userId, "proposal_run");

  const llm = createLLM(config);
  if (!llm.bindTools) {
    throw new Error(`Provider ${config.provider} does not support bindTools — streaming requires it.`);
  }
  const modelWithTool = llm.bindTools(
    [{ name: "folder_proposal", description: "Folder structure proposal", schema: ProposalSchema }],
    { tool_choice: { type: "tool", name: "folder_proposal" } },
  );

  const runStream = traceable(
    async (messages: { system: string; user: string }) => {
      return modelWithTool.stream([
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
        streaming: true,
      },
    },
  );
  const stream = await runStream({ system: config.systemPrompt, user: userPrompt });

  const parser = new FolderStreamParser();
  const accepted: ProposedFolder[] = [];
  let ruleCount = 0;

  const handleFolder = async (folder: ProposedFolder) => {
    await insertProposedFoldersPg(userId, [{ path: folder.path, rationale: folder.rationale }]);
    for (const r of folder.rules) {
      await insertFolderRulePg(userId, {
        match_type: r.match_type,
        match_value: r.match_value,
        action: "route_to",
        target_folder: folder.path,
        source: "llm_proposal",
        confidence: r.confidence,
        status: "proposed",
      });
      ruleCount++;
    }
    accepted.push(folder);
    console.log(
      `  + ${folder.path} (${folder.rules.length} rule${folder.rules.length === 1 ? "" : "s"})`,
    );
  };

  for await (const chunk of stream) {
    for (const tc of chunk.tool_call_chunks ?? []) {
      if (!tc.args) continue;
      for (const folderJson of parser.feed(tc.args)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(folderJson);
        } catch (e) {
          console.warn(`Skipping unparseable folder fragment: ${(e as Error).message}`);
          continue;
        }
        const result = FolderSchema.safeParse(parsed);
        if (!result.success) {
          console.warn(`Skipping folder failing schema: ${result.error.message}`);
          continue;
        }
        await handleFolder(result.data);
      }
    }
  }

  console.log(
    `Inserted ${accepted.length} proposed folders and ${ruleCount} rules. Review at /mail-analyzer/proposals.`,
  );

  await writeMemoryPg(userId, {
    kind: "proposal_run",
    source: "llm",
    content: `Proposed ${accepted.length} folders and ${ruleCount} routing rules using ${config.provider}/${config.model}. Considered ${senders.length} senders and ${existingMailboxes.length} existing mailboxes. Strategy: ${folderStrategy ?? "(none saved)"}.`,
  });
  for (const f of accepted) {
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
