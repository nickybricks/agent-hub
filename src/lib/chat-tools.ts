/**
 * Phase 3.5 tool registry. Read-only tools auto-run; mutating tools produce a
 * preview the user must confirm before execute fires. Dual-path: every executor
 * branches on userId (null = SQLite single-user, set = Postgres tenant).
 */

import {
  getProposalsWithRules,
  getFolderRule,
  listAuditFindings,
  getSendersForProposal,
  listRecentMoves,
  listMemories,
  updateProposedFolderPath,
  setProposedFolderStatus,
  setFolderRuleStatus,
  updateFolderRuleMatch,
  dismissAuditFinding,
  setMessageOverride,
  writeMemory,
  type AuditFindingKind,
  type ProposedFolderStatus,
  type FolderRuleStatus,
} from "./analyzer-db";
import {
  getProposalsWithRulesPg,
  getFolderRulePg,
  listAuditFindingsPg,
  getSendersForProposalPg,
  listRecentMovesPg,
  listMemoriesPg,
  updateProposedFolderPathPg,
  setProposedFolderStatusPg,
  setFolderRuleStatusPg,
  updateFolderRuleMatchPg,
  dismissAuditFindingPg,
  setMessageOverridePg,
  writeMemoryPg,
} from "./analyzer-db-pg";
import { previewRule, applyRule } from "./apply-rule";

export type ToolKind = "read" | "mutate" | "ask" | "onboard";

export interface ToolSpec {
  name: string;
  kind: ToolKind;
  description: string;
  schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
}

const FOLDER_STATUSES: ProposedFolderStatus[] = ["proposed", "accepted", "rejected", "created"];
const RULE_STATUSES: FolderRuleStatus[] = ["proposed", "accepted", "rejected"];
const AUDIT_KINDS: AuditFindingKind[] = [
  "false_positive_spam",
  "false_negative_inbox",
  "phishing_risk",
  "hygiene_stale_sender",
  "hygiene_storage_hog",
];

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "ask_user",
    kind: "ask",
    description:
      "Ask the user a clarifying question when discrete choices exist. Provide 2–4 short predefined options they can click; they may also answer freely. Ends your turn until they reply. Prefer this over a plain question when the answer is a choice.",
    schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "the clarifying question" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "2–4 short answer options the user can click",
        },
      },
      required: ["question", "options"],
      additionalProperties: false,
    },
  },
  {
    name: "connect_mailbox",
    kind: "onboard",
    description:
      "Show the user an in-chat card to connect their mailbox (IMAP / Gmail / Outlook). Call this once, only during onboarding, when the mailbox is not yet connected. Ends your turn until they connect.",
    schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "save_onboarding_answer",
    kind: "read",
    description:
      "Persist one questionnaire answer during onboarding as a durable preference. Call this immediately after the user answers each onboarding question. Auto-runs (no confirmation).",
    schema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description:
            "stable slug for the question, e.g. 'mailbox_type' | 'folder_style' | 'cleanup_aggressiveness' | 'occupation' | 'sacred'",
        },
        answer: { type: "string", description: "the user's answer, verbatim or lightly normalised" },
      },
      required: ["key", "answer"],
      additionalProperties: false,
    },
  },
  {
    name: "run_pipeline",
    kind: "onboard",
    description:
      "Trigger the mailbox scan + sender classification, stream progress to the user, then synthesise a draft persona and present it for confirmation. Call this once, only during onboarding, after the questionnaire is complete and the mailbox is connected. Ends your turn.",
    schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_proposed_folders",
    kind: "read",
    description:
      "List every proposed folder with its status, rationale, and the LLM-proposed rules attached to it. Use this before suggesting taxonomy changes.",
    schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_folder_rule",
    kind: "read",
    description: "Get one folder rule by its numeric id (match type/value, target folder, status, confidence).",
    schema: {
      type: "object",
      properties: { id: { type: "number", description: "folder_rules.id" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_audit_findings",
    kind: "read",
    description: "List open audit findings, optionally filtered by kind.",
    schema: {
      type: "object",
      properties: { kind: { type: "string", enum: AUDIT_KINDS } },
      additionalProperties: false,
    },
  },
  {
    name: "query_senders",
    kind: "read",
    description:
      "List senders with message counts and category. Optional category filter and result limit. Use to reason about who should go where.",
    schema: {
      type: "object",
      properties: {
        category: { type: "string", description: "exact category to filter by (optional)" },
        limit: { type: "number", description: "max rows (default 50)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "recent_moves",
    kind: "read",
    description: "List recent message-move log entries (most recent first).",
    schema: {
      type: "object",
      properties: { limit: { type: "number", description: "max rows (default 30)" } },
      additionalProperties: false,
    },
  },
  {
    name: "list_memories",
    kind: "read",
    description: "List stored agent memories (decisions, preferences, rationales), optionally filtered by kind.",
    schema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "memory kind filter (optional)" },
        limit: { type: "number", description: "max rows (default 50)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "rename_proposed_folder",
    kind: "mutate",
    description: "Rename a proposed folder's path. Requires user confirmation.",
    schema: {
      type: "object",
      properties: {
        id: { type: "number", description: "proposed_folders.id" },
        new_path: { type: "string", description: "new folder path, e.g. 'Newsletters/Tech'" },
      },
      required: ["id", "new_path"],
      additionalProperties: false,
    },
  },
  {
    name: "set_proposed_folder_status",
    kind: "mutate",
    description: "Change a proposed folder's status. Requires user confirmation.",
    schema: {
      type: "object",
      properties: {
        id: { type: "number" },
        status: { type: "string", enum: FOLDER_STATUSES },
      },
      required: ["id", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "set_rule_status",
    kind: "mutate",
    description: "Accept/reject/reset a folder rule (does NOT move messages — use apply_rule for that). Requires confirmation.",
    schema: {
      type: "object",
      properties: {
        id: { type: "number" },
        status: { type: "string", enum: RULE_STATUSES },
      },
      required: ["id", "status"],
      additionalProperties: false,
    },
  },
  {
    name: "update_rule_match",
    kind: "mutate",
    description: "Edit a folder rule's match value and/or target folder. Requires confirmation.",
    schema: {
      type: "object",
      properties: {
        id: { type: "number" },
        match_value: { type: "string" },
        target_folder: { type: "string", description: "new target folder (omit to keep)" },
      },
      required: ["id", "match_value"],
      additionalProperties: false,
    },
  },
  {
    name: "apply_rule",
    kind: "mutate",
    description:
      "Apply a folder rule: actually move matching messages into the target folder via the mail provider. ALWAYS preview first; requires explicit confirmation. Irreversible except via the history Undo.",
    schema: {
      type: "object",
      properties: {
        ruleId: { type: "number" },
        makeRule: {
          type: "boolean",
          description: "true = accept rule for future auto-routing; false = one-off backfill only (default true)",
        },
      },
      required: ["ruleId"],
      additionalProperties: false,
    },
  },
  {
    name: "dismiss_audit_finding",
    kind: "mutate",
    description: "Dismiss (close) an open audit finding by id. Requires confirmation.",
    schema: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "set_audit_override",
    kind: "mutate",
    description: "Override the audit verdict for a single message. Requires confirmation.",
    schema: {
      type: "object",
      properties: {
        message_id: { type: "string" },
        kind: { type: "string", enum: AUDIT_KINDS },
        decision: { type: "string", enum: ["include", "exclude", "agree"] },
      },
      required: ["message_id", "kind", "decision"],
      additionalProperties: false,
    },
  },
  {
    name: "write_memory",
    kind: "mutate",
    description:
      "Persist a durable note for future sessions (a user preference or decision rationale). Requires confirmation.",
    schema: {
      type: "object",
      properties: {
        content: { type: "string" },
        key: { type: "string", description: "optional grouping key" },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
];

const SPEC_BY_NAME = new Map(TOOL_SPECS.map((s) => [s.name, s]));

export function getToolSpec(name: string): ToolSpec | undefined {
  return SPEC_BY_NAME.get(name);
}

type Input = Record<string, unknown>;
const num = (v: unknown) => Number(v);
const str = (v: unknown) => String(v);

/** Execute a read-only tool immediately. Returns a JSON-able result. */
export async function runReadTool(
  userId: string | null,
  name: string,
  input: Input,
): Promise<unknown> {
  switch (name) {
    case "list_proposed_folders":
      return userId ? getProposalsWithRulesPg(userId) : getProposalsWithRules();
    case "get_folder_rule":
      return userId ? getFolderRulePg(userId, num(input.id)) : getFolderRule(num(input.id));
    case "list_audit_findings": {
      const kind = input.kind ? (str(input.kind) as AuditFindingKind) : undefined;
      return userId ? listAuditFindingsPg(userId, kind) : listAuditFindings(kind);
    }
    case "query_senders": {
      const limit = input.limit ? num(input.limit) : 50;
      const all = userId
        ? await getSendersForProposalPg(userId, 1, 500)
        : getSendersForProposal(1, 500);
      const filtered = input.category
        ? all.filter((s) => s.category === str(input.category))
        : all;
      return filtered.slice(0, limit);
    }
    case "recent_moves": {
      const limit = input.limit ? num(input.limit) : 30;
      return userId ? listRecentMovesPg(userId, limit) : listRecentMoves(limit);
    }
    case "save_onboarding_answer": {
      const memo = {
        kind: "user_pref" as const,
        key: `onboarding:${str(input.key)}`,
        content: str(input.answer),
        source: "user_decision" as const,
      };
      const id = userId ? await writeMemoryPg(userId, memo) : writeMemory(memo);
      return { ok: true, memory_id: id };
    }
    case "list_memories": {
      const filter = {
        kind: input.kind ? str(input.kind) : undefined,
        limit: input.limit ? num(input.limit) : 50,
      };
      return userId
        ? listMemoriesPg(userId, filter)
        : listMemories({ kind: filter.kind as never, limit: filter.limit });
    }
    default:
      throw new Error(`unknown read tool: ${name}`);
  }
}

export interface MutationPreview {
  summary: string;
  details?: unknown;
}

/** Build the confirm-card payload for a mutating tool. Performs NO writes. */
export async function previewMutation(
  userId: string | null,
  name: string,
  input: Input,
): Promise<MutationPreview> {
  switch (name) {
    case "rename_proposed_folder":
      return { summary: `Rename proposed folder #${num(input.id)} → "${str(input.new_path)}".` };
    case "set_proposed_folder_status":
      return { summary: `Set proposed folder #${num(input.id)} status → "${str(input.status)}".` };
    case "set_rule_status": {
      const rule = userId
        ? await getFolderRulePg(userId, num(input.id))
        : getFolderRule(num(input.id));
      return {
        summary: `Set rule #${num(input.id)} status → "${str(input.status)}".`,
        details: rule,
      };
    }
    case "update_rule_match":
      return {
        summary: `Update rule #${num(input.id)} match → "${str(input.match_value)}"${
          input.target_folder ? `, target → "${str(input.target_folder)}"` : ""
        }.`,
      };
    case "apply_rule": {
      const p = await previewRule(userId, num(input.ruleId));
      return {
        summary: `Apply rule #${num(input.ruleId)} (${p.rule.match_type}=${p.rule.match_value} → ${p.rule.target_folder}): ${p.total} message(s) across ${p.groups.length} source folder(s).`,
        details: p,
      };
    }
    case "dismiss_audit_finding":
      return { summary: `Dismiss audit finding #${num(input.id)}.` };
    case "set_audit_override":
      return {
        summary: `Override audit for message ${str(input.message_id)} (${str(input.kind)}) → "${str(input.decision)}".`,
      };
    case "write_memory":
      return { summary: `Save memory: "${str(input.content)}"${input.key ? ` [key=${str(input.key)}]` : ""}.` };
    default:
      throw new Error(`unknown mutating tool: ${name}`);
  }
}

/** Execute a mutating tool (only call after user confirmation). */
export async function executeMutation(
  userId: string | null,
  name: string,
  input: Input,
): Promise<unknown> {
  switch (name) {
    case "rename_proposed_folder":
      if (userId) await updateProposedFolderPathPg(userId, num(input.id), str(input.new_path));
      else updateProposedFolderPath(num(input.id), str(input.new_path));
      return { ok: true };
    case "set_proposed_folder_status": {
      const status = str(input.status) as ProposedFolderStatus;
      if (userId) await setProposedFolderStatusPg(userId, num(input.id), status);
      else setProposedFolderStatus(num(input.id), status);
      return { ok: true };
    }
    case "set_rule_status": {
      const status = str(input.status) as FolderRuleStatus;
      if (userId) await setFolderRuleStatusPg(userId, num(input.id), status);
      else setFolderRuleStatus(num(input.id), status);
      return { ok: true };
    }
    case "update_rule_match": {
      const target = input.target_folder != null ? str(input.target_folder) : null;
      if (userId) await updateFolderRuleMatchPg(userId, num(input.id), str(input.match_value), target);
      else updateFolderRuleMatch(num(input.id), str(input.match_value), target);
      return { ok: true };
    }
    case "apply_rule":
      return applyRule(userId, num(input.ruleId), input.makeRule !== false);
    case "dismiss_audit_finding":
      if (userId) await dismissAuditFindingPg(userId, num(input.id));
      else dismissAuditFinding(num(input.id));
      return { ok: true };
    case "set_audit_override": {
      const kind = str(input.kind) as AuditFindingKind;
      const decision = str(input.decision) as "include" | "exclude" | "agree";
      if (userId) await setMessageOverridePg(userId, str(input.message_id), kind, decision);
      else setMessageOverride(str(input.message_id), kind, decision);
      return { ok: true };
    }
    case "write_memory": {
      const memo = {
        kind: "user_pref" as const,
        key: input.key != null ? str(input.key) : null,
        content: str(input.content),
        source: "user_decision" as const,
      };
      const id = userId ? await writeMemoryPg(userId, memo) : writeMemory(memo);
      return { ok: true, memory_id: id };
    }
    default:
      throw new Error(`unknown mutating tool: ${name}`);
  }
}
