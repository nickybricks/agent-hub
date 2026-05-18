/**
 * Detect near-duplicate *real* mailbox folders — the mess left behind when an
 * earlier double-onboarding applied two slightly different taxonomies (e.g.
 * "Real Estate" + "Housing", "Shopping/Orders" + "Shopping/Parcels"). These are
 * semantic, not lexical, duplicates, so a cheap LLM clusters them. Read-only:
 * we only *surface* a merge suggestion (no delete — consolidation moves are the
 * user's call, per the no-delete / Archive-only policy). Multi-tenant only.
 */

import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { z } from "zod";
import { createLLM, LLMConfig } from "@/agent/summarize";
import { getProposalFolderRowsPg } from "./analyzer-db-pg";

const SYSTEM = `You are auditing an email account's folder list for redundant folders.
Group folders that serve the SAME purpose under different names (semantic duplicates, e.g. "Real Estate" and "Housing", or "Shopping/Parcels" and "Shopping/Orders"). Do NOT group folders that are merely related but distinct (e.g. "Travel" vs "Mobility" are distinct). Ignore system folders (INBOX, Sent, Drafts, Trash, Spam, Junk, Archive).
For each duplicate cluster pick the clearest existing name as the canonical keeper and list the others as merge-into candidates. Only output clusters with a genuine duplicate (2+ folders). If there are none, output an empty list.`;

const Schema = z.object({
  clusters: z
    .array(
      z.object({
        keep: z.string().describe("Canonical folder name to keep (must be one of the input folders)."),
        merge: z
          .array(z.string())
          .describe("Other existing folders that duplicate `keep` and should be merged into it."),
        reason: z.string().describe("One short sentence on why these are the same."),
      }),
    )
    .describe("Duplicate clusters; empty if no duplicates."),
});

export interface DuplicateCluster {
  keep: string;
  merge: string[];
  reason: string;
}

function envLLM(): LLMConfig {
  const provider = process.env.OPENAI_API_KEY ? "openai" : "anthropic";
  const model = provider === "openai" ? "gpt-4o-mini" : "claude-haiku-4-5-20251001";
  return { provider, model, systemPrompt: SYSTEM };
}

export async function findDuplicateFolders(userId: string): Promise<DuplicateCluster[]> {
  const rows = await getProposalFolderRowsPg(userId);
  const names = rows.map((r) => r.name).filter(Boolean);
  if (names.length < 2) return [];

  const llm = createLLM(envLLM());
  const structured = llm.withStructuredOutput(Schema, { name: "duplicate_clusters" });
  const out = await structured.invoke([
    new SystemMessage(SYSTEM),
    new HumanMessage(
      `Existing folders (with message counts):\n${rows
        .map((r) => `- ${r.name} (${r.msg_count})`)
        .join("\n")}`,
    ),
  ]);

  const valid = new Set(names);
  return out.clusters
    .map((c) => ({
      keep: c.keep,
      merge: c.merge.filter((m) => valid.has(m) && m !== c.keep),
      reason: c.reason,
    }))
    .filter((c) => valid.has(c.keep) && c.merge.length > 0);
}
