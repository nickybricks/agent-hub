/**
 * Phase 3.5 tool registry. Read-only tools auto-run; mutating tools produce a
 * preview the user must confirm before execute fires.
 */

import type {
  AuditFindingKind,
  ProposedFolderStatus,
  FolderRuleStatus,
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
  supersedeMemoryPg,
  insertProposedFoldersPg,
  insertFolderRulePg,
  getProposedFolderByPathPg,
  clearPendingProposalsPg,
} from "./analyzer-db-pg";
import { previewRule, applyRule } from "./apply-rule";

export type ToolKind = "read" | "mutate" | "ask" | "onboard";

// Shared option shape for ask_user. `label` is what the user sees on the
// button; `hint` is a one-line plain-language explanation; `recommended`
// flags at most one option as the suggested default.
export interface AskOption {
  label: string;
  hint?: string;
  recommended?: boolean;
}

// Tolerant of legacy string-array shapes and back-compat with model slips.
export function normalizeAskOptions(raw: unknown): AskOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AskOption[] = [];
  let recommendedSeen = false;
  for (const item of raw) {
    if (typeof item === "string") {
      const label = item.trim();
      if (label) out.push({ label });
    } else if (item && typeof item === "object") {
      const o = item as { label?: unknown; hint?: unknown; recommended?: unknown };
      const label = typeof o.label === "string" ? o.label.trim() : "";
      if (!label) continue;
      const opt: AskOption = { label };
      if (typeof o.hint === "string" && o.hint.trim()) opt.hint = o.hint.trim();
      if (o.recommended === true && !recommendedSeen) {
        opt.recommended = true;
        recommendedSeen = true;
      }
      out.push(opt);
    }
    if (out.length >= 4) break;
  }
  return out;
}

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
      "Ask the user a clarifying question when discrete choices exist. Provide 2–4 short options as objects { label, hint, recommended }: `label` is the short button text (required), `hint` is a one-line plain-language explanation of what the option means or does (strongly encouraged), and at most ONE option may set `recommended: true` — its `hint` should start with the reason you'd advise it. Recommend an option whenever you sensibly can; skip the badge only when the choice is genuinely user-preference with no better default. The user may also type a free answer. Ends your turn until they reply. Prefer this over a plain question when the answer is a choice.",
    schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "the clarifying question" },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "short button text the user clicks" },
              hint: {
                type: "string",
                description: "one-line plain-language explanation of what this option means or does",
              },
              recommended: {
                type: "boolean",
                description: "true on at most one option you'd advise; its hint should start with the reason",
              },
            },
            required: ["label"],
            additionalProperties: false,
          },
          description: "2–4 answer options",
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
            "stable slug for the question: 'mailbox_type' | 'folder_style' | 'cleanup_aggressiveness' | 'sacred'",
        },
        answer: { type: "string", description: "the user's answer, verbatim or lightly normalised" },
      },
      required: ["key", "answer"],
      additionalProperties: false,
    },
  },
  {
    name: "remember_about_user",
    kind: "read",
    description:
      "Save a short, durable personal fact the user volunteered (their name, what to call them, the name they gave you, occupation, a sentence of personal context). Auto-runs. Only call when the user actually reveals something durable — never interrogate, never speculate. One concise first-person-about-the-user note per call; the system merges it into a single evolving 'soul' memory.",
    schema: {
      type: "object",
      properties: {
        note: {
          type: "string",
          description: "one concise note, e.g. 'Prefers to be called Nick.' or 'Works as a data scientist on observability.'",
        },
      },
      required: ["note"],
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
    name: "clear_pending_proposals",
    kind: "mutate",
    description:
      "Bulk-delete every currently pending (un-accepted) proposed folder and its proposed LLM rules. Accepted and already-created folders are KEPT — only `proposed` rows are removed. Use when the user wants a clean slate on the Proposals tab before generating or hand-crafting a new taxonomy. Requires confirmation.",
    schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "trigger_propose_structure",
    kind: "mutate",
    description:
      "Rebuild the folder-proposal taxonomy from scratch: fires the same proposal job onboarding uses. Streams new folders one-by-one into the Proposals tab over 1–3 minutes. Clears any currently pending (un-accepted) proposals first; accepted/rejected proposals are preserved. Requires confirmation. Use when the user asks to regenerate or rebuild proposals.",
    schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "add_proposed_folder",
    kind: "mutate",
    description:
      "Add a single proposed folder with one or more sender-routing rules. Use when the user describes a specific folder they want (e.g. 'add a folder for invoices from these senders'). Requires confirmation. Inserts a `proposed` folder row plus its rules; rules land as `proposed` until the user accepts them on the Proposals tab.",
    schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "folder path, e.g. 'Invoices' or 'Newsletters/Tech' (subfolders split on /)",
        },
        rationale: {
          type: "string",
          description: "one-sentence reason for this folder (shown on the Proposals tab)",
        },
        rules: {
          type: "array",
          description: "1+ sender rules that should route mail into this folder",
          items: {
            type: "object",
            properties: {
              match_type: {
                type: "string",
                enum: ["sender_email", "sender_domain"],
                description: "match by full email address or by domain",
              },
              match_value: {
                type: "string",
                description: "the email or domain to match, lowercased",
              },
              confidence: {
                type: "number",
                description: "0..1 LLM-style confidence (optional)",
              },
            },
            required: ["match_type", "match_value"],
            additionalProperties: false,
          },
        },
      },
      required: ["path", "rules"],
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
  userId: string,
  name: string,
  input: Input,
): Promise<unknown> {
  switch (name) {
    case "list_proposed_folders":
      return getProposalsWithRulesPg(userId);
    case "get_folder_rule":
      return getFolderRulePg(userId, num(input.id));
    case "list_audit_findings": {
      const kind = input.kind ? (str(input.kind) as AuditFindingKind) : undefined;
      return listAuditFindingsPg(userId, kind);
    }
    case "query_senders": {
      const limit = input.limit ? num(input.limit) : 50;
      const all = await getSendersForProposalPg(userId, 1, 500);
      const filtered = input.category
        ? all.filter((s) => s.category === str(input.category))
        : all;
      return filtered.slice(0, limit);
    }
    case "recent_moves": {
      const limit = input.limit ? num(input.limit) : 30;
      return listRecentMovesPg(userId, limit);
    }
    case "remember_about_user": {
      const note = str(input.note).trim();
      if (!note) return { ok: false, error: "empty note" };
      const existing = (await listMemoriesPg(userId, { kind: "soul", limit: 1 })) as Array<{
        id: number;
        content: string;
      }>;
      const prev = existing[0];
      const prevLines = prev
        ? prev.content
            .split("\n")
            .map((s) => s.replace(/^[-•]\s*/, "").trim())
            .filter(Boolean)
        : [];
      if (prevLines.some((l) => l.toLowerCase() === note.toLowerCase())) {
        return { ok: true, memory_id: prev!.id, unchanged: true };
      }
      const merged = [...prevLines, note].map((l) => `- ${l}`).join("\n");
      const newId = await writeMemoryPg(userId, {
        kind: "soul",
        key: "soul",
        content: merged,
        source: "user_decision",
      });
      if (prev) await supersedeMemoryPg(userId, prev.id, newId);
      return { ok: true, memory_id: newId };
    }
    case "save_onboarding_answer": {
      const id = await writeMemoryPg(userId, {
        kind: "user_pref",
        key: `onboarding:${str(input.key)}`,
        content: str(input.answer),
        source: "user_decision",
      });
      return { ok: true, memory_id: id };
    }
    case "list_memories": {
      const filter = {
        kind: input.kind ? str(input.kind) : undefined,
        limit: input.limit ? num(input.limit) : 50,
      };
      return listMemoriesPg(userId, filter);
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
  userId: string,
  name: string,
  input: Input,
): Promise<MutationPreview> {
  switch (name) {
    case "rename_proposed_folder":
      return { summary: `Rename proposed folder #${num(input.id)} → "${str(input.new_path)}".` };
    case "set_proposed_folder_status":
      return { summary: `Set proposed folder #${num(input.id)} status → "${str(input.status)}".` };
    case "set_rule_status": {
      const rule = await getFolderRulePg(userId, num(input.id));
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
    case "clear_pending_proposals": {
      const all = await getProposalsWithRulesPg(userId);
      const pending = all.filter((p) => p.folder.status === "proposed");
      const ruleCount = pending.reduce((n, p) => n + p.rules.length, 0);
      return {
        summary: `Delete ${pending.length} pending proposal(s) and ${ruleCount} proposed rule(s). Accepted/created folders are kept.`,
        details: { folders: pending.map((p) => p.folder.path) },
      };
    }
    case "trigger_propose_structure":
      return {
        summary:
          "Rebuild folder proposals from scratch. Clears any pending proposals, then streams a fresh taxonomy into the Proposals tab over the next 1–3 minutes.",
      };
    case "add_proposed_folder": {
      const rules = Array.isArray(input.rules) ? (input.rules as Array<Record<string, unknown>>) : [];
      const matches = rules
        .map((r) => `${str(r.match_type)}=${str(r.match_value)}`)
        .join(", ");
      return {
        summary: `Add proposed folder "${str(input.path)}" with ${rules.length} rule(s)${
          matches ? ` (${matches})` : ""
        }.`,
        details: { path: str(input.path), rationale: input.rationale ?? null, rules },
      };
    }
    default:
      throw new Error(`unknown mutating tool: ${name}`);
  }
}

/** Execute a mutating tool (only call after user confirmation). */
export async function executeMutation(
  userId: string,
  name: string,
  input: Input,
): Promise<unknown> {
  switch (name) {
    case "rename_proposed_folder":
      await updateProposedFolderPathPg(userId, num(input.id), str(input.new_path));
      return { ok: true };
    case "set_proposed_folder_status": {
      const status = str(input.status) as ProposedFolderStatus;
      await setProposedFolderStatusPg(userId, num(input.id), status);
      return { ok: true };
    }
    case "set_rule_status": {
      const status = str(input.status) as FolderRuleStatus;
      await setFolderRuleStatusPg(userId, num(input.id), status);
      return { ok: true };
    }
    case "update_rule_match": {
      const target = input.target_folder != null ? str(input.target_folder) : null;
      await updateFolderRuleMatchPg(userId, num(input.id), str(input.match_value), target);
      return { ok: true };
    }
    case "apply_rule":
      return applyRule(userId, num(input.ruleId), input.makeRule !== false);
    case "dismiss_audit_finding":
      await dismissAuditFindingPg(userId, num(input.id));
      return { ok: true };
    case "set_audit_override": {
      const kind = str(input.kind) as AuditFindingKind;
      const decision = str(input.decision) as "include" | "exclude" | "agree";
      await setMessageOverridePg(userId, str(input.message_id), kind, decision);
      return { ok: true };
    }
    case "write_memory": {
      const id = await writeMemoryPg(userId, {
        kind: "user_pref",
        key: input.key != null ? str(input.key) : null,
        content: str(input.content),
        source: "user_decision",
      });
      return { ok: true, memory_id: id };
    }
    case "clear_pending_proposals": {
      await clearPendingProposalsPg(userId);
      return { ok: true };
    }
    case "trigger_propose_structure": {
      const { inngest } = await import("@/inngest/client");
      await inngest.send({ name: "mail/propose", data: { userId } });
      return { ok: true, queued: true };
    }
    case "add_proposed_folder": {
      const path = str(input.path).trim();
      const rationale = input.rationale != null ? str(input.rationale) : null;
      const rawRules = Array.isArray(input.rules) ? (input.rules as Array<Record<string, unknown>>) : [];
      if (!path) throw new Error("path is required");
      if (rawRules.length === 0) throw new Error("at least one rule is required");

      await insertProposedFoldersPg(userId, [{ path, rationale }]);
      const folder = await getProposedFolderByPathPg(userId, path);
      const ruleIds: number[] = [];
      for (const r of rawRules) {
        const matchType = str(r.match_type) as "sender_email" | "sender_domain";
        if (matchType !== "sender_email" && matchType !== "sender_domain") {
          throw new Error(`invalid match_type: ${matchType}`);
        }
        const id = await insertFolderRulePg(userId, {
          match_type: matchType,
          match_value: str(r.match_value),
          action: "route_to",
          target_folder: path,
          source: "llm_proposal",
          confidence: r.confidence != null ? num(r.confidence) : null,
          status: "proposed",
        });
        ruleIds.push(id);
      }
      return { ok: true, folder_id: folder?.id ?? null, rule_ids: ruleIds };
    }
    default:
      throw new Error(`unknown mutating tool: ${name}`);
  }
}
