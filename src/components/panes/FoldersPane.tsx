"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { X, ChevronRight, ChevronDown, Trash2, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useRevalidate } from "@/components/DataSync";

type MatchType = "sender_email" | "sender_domain";
type RuleStatus = "proposed" | "accepted" | "rejected";

interface SampleSubject {
  id: string;
  subject: string | null;
  sender_email: string;
  date_received: string;
}

interface Rule {
  id: number;
  match_type: MatchType;
  match_value: string;
  action: string;
  target_folder: string | null;
  status: RuleStatus;
  source: string;
  confidence: number | null;
  samples: SampleSubject[];
}

interface FolderRow {
  id: number;
  name: string;
  msg_count: number;
  top_senders: { sender_email: string; c: number }[];
  top_categories: { category: string; c: number }[];
}

const PHASE3_TOOLTIP = "Coming once folder writes are wired.";

function summary(row: FolderRow): string {
  const senders = row.top_senders.slice(0, 2).map((s) => s.sender_email).join(", ");
  const cats = row.top_categories
    .slice(0, 2)
    .map((c) => c.category)
    .filter((c) => c)
    .join(", ");
  const parts: string[] = [];
  if (senders) parts.push(`top: ${senders}`);
  if (cats) parts.push(cats);
  return parts.join(" · ");
}

export default function FoldersPane({ active }: { active: boolean }) {
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const { toast } = useToast();

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/mail-analyzer/folders");
      if (!res.ok) throw new Error("failed to load folders");
      const data = await res.json();
      setFolders(data.folders ?? []);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useRevalidate(active, load);

  // Group on the first path segment so the tree has one accordion level.
  // Anything deeper keeps its full sub-path as the sub-row label — keeps the
  // UI calm without inventing arbitrary intermediate nodes.
  const tree = useMemo(() => {
    const groups = new Map<string, FolderRow[]>();
    const tops: FolderRow[] = [];
    for (const f of folders) {
      const slash = f.name.indexOf("/");
      if (slash === -1) {
        tops.push(f);
      } else {
        const root = f.name.slice(0, slash);
        const arr = groups.get(root) ?? [];
        arr.push(f);
        groups.set(root, arr);
      }
    }
    // Top-level rows shown in order: those that exist as their own mailbox
    // first, then synthetic "parent only contains children" rows.
    const seen = new Set(tops.map((t) => t.name));
    const synthetic: { name: string; msg_count: number }[] = [];
    for (const [root, kids] of groups) {
      if (!seen.has(root)) {
        synthetic.push({
          name: root,
          msg_count: kids.reduce((n, k) => n + k.msg_count, 0),
        });
      }
    }
    return { tops, groups, synthetic };
  }, [folders]);

  const toggleExpanded = (root: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-8 py-10">
        <p className="text-sm text-muted">Loading folders…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-10">
        <div>
          <h1 className="mb-1 text-2xl font-semibold tracking-tight">Folders</h1>
          <p className="text-sm text-muted">
            The current structure of your mailbox lives here.
          </p>
        </div>
        <div className="rounded-xl border border-border bg-danger-soft p-4 text-sm">
          Couldn&apos;t load your folders. Try again in a moment.
        </div>
      </div>
    );
  }

  if (folders.length === 0) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-10">
        <div>
          <h1 className="mb-1 text-2xl font-semibold tracking-tight">Folders</h1>
          <p className="text-sm text-muted">
            The current structure of your mailbox lives here.
          </p>
        </div>
        <div className="rounded-xl border border-border bg-warning-soft p-4 text-sm">
          Accept a proposal to start building your structure.
        </div>
      </div>
    );
  }

  const totalMessages = folders.reduce((n, f) => n + f.msg_count, 0);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-10">
      <div>
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">Folders</h1>
        <p className="text-sm text-muted">
          {folders.length} folder{folders.length === 1 ? "" : "s"} · {totalMessages.toLocaleString()}{" "}
          message{totalMessages === 1 ? "" : "s"}. Click a folder to view and edit its rules.
        </p>
      </div>

      <div className="card overflow-hidden">
        <div className="divide-y divide-border">
          {/* Top-level real folders */}
          {tree.tops.map((f) => {
            const kids = tree.groups.get(f.name) ?? [];
            const open = expanded.has(f.name);
            return (
              <FolderGroup
                key={`top-${f.id}`}
                row={f}
                kids={kids}
                open={open}
                onToggle={() => toggleExpanded(f.name)}
                onOpen={(name) => setOpenFolder(name)}
              />
            );
          })}
          {/* Synthetic parents (only sub-folders exist for them) */}
          {tree.synthetic.map((s) => {
            const kids = tree.groups.get(s.name) ?? [];
            const open = expanded.has(s.name);
            return (
              <SyntheticGroup
                key={`syn-${s.name}`}
                name={s.name}
                msgCount={s.msg_count}
                kids={kids}
                open={open}
                onToggle={() => toggleExpanded(s.name)}
                onOpen={(name) => setOpenFolder(name)}
              />
            );
          })}
        </div>
      </div>

      {openFolder && (
        <FolderDetailModal
          folderName={openFolder}
          onClose={() => setOpenFolder(null)}
          onMutate={() => {
            toast("Saved.", "success");
            load();
          }}
        />
      )}
    </div>
  );
}

function FolderRowDisplay({
  row,
  indent,
  onOpen,
}: {
  row: FolderRow;
  indent: boolean;
  onOpen: () => void;
}) {
  const blurb = summary(row);
  return (
    <button
      onClick={onOpen}
      className={`flex w-full items-center justify-between gap-4 px-5 py-3 text-left transition-colors hover:bg-card-hover/40 ${
        indent ? "pl-12" : ""
      }`}
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{row.name}</p>
        {blurb && <p className="mt-0.5 truncate text-xs text-muted">{blurb}</p>}
      </div>
      <span className="shrink-0 text-xs text-muted tabular-nums">
        {row.msg_count.toLocaleString()}
      </span>
    </button>
  );
}

function FolderGroup({
  row,
  kids,
  open,
  onToggle,
  onOpen,
}: {
  row: FolderRow;
  kids: FolderRow[];
  open: boolean;
  onToggle: () => void;
  onOpen: (name: string) => void;
}) {
  return (
    <div>
      <div className="flex items-stretch">
        {kids.length > 0 ? (
          <button
            onClick={onToggle}
            aria-label={open ? "Collapse" : "Expand"}
            className="flex w-9 shrink-0 items-center justify-center text-muted transition-colors hover:bg-card-hover/40 hover:text-foreground"
          >
            {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        ) : (
          <div className="w-9 shrink-0" />
        )}
        <div className="flex-1">
          <FolderRowDisplay row={row} indent={false} onOpen={() => onOpen(row.name)} />
        </div>
      </div>
      {open && kids.length > 0 && (
        <div className="border-t border-border bg-card-hover/20">
          {kids.map((k) => (
            <FolderRowDisplay key={k.id} row={k} indent onOpen={() => onOpen(k.name)} />
          ))}
        </div>
      )}
    </div>
  );
}

function SyntheticGroup({
  name,
  msgCount,
  kids,
  open,
  onToggle,
  onOpen,
}: {
  name: string;
  msgCount: number;
  kids: FolderRow[];
  open: boolean;
  onToggle: () => void;
  onOpen: (name: string) => void;
}) {
  return (
    <div>
      <div className="flex items-stretch">
        <button
          onClick={onToggle}
          aria-label={open ? "Collapse" : "Expand"}
          className="flex w-9 shrink-0 items-center justify-center text-muted transition-colors hover:bg-card-hover/40 hover:text-foreground"
        >
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <div className="flex flex-1 items-center justify-between gap-4 px-5 py-3 text-left">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="mt-0.5 truncate text-xs text-muted">
              {kids.length} sub-folder{kids.length === 1 ? "" : "s"}
            </p>
          </div>
          <span className="shrink-0 text-xs text-muted tabular-nums">
            {msgCount.toLocaleString()}
          </span>
        </div>
      </div>
      {open && (
        <div className="border-t border-border bg-card-hover/20">
          {kids.map((k) => (
            <FolderRowDisplay key={k.id} row={k} indent onOpen={() => onOpen(k.name)} />
          ))}
        </div>
      )}
    </div>
  );
}

function FolderDetailModal({
  folderName,
  onClose,
  onMutate,
}: {
  folderName: string;
  onClose: () => void;
  onMutate: () => void;
}) {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const load = useCallback(async () => {
    const res = await fetch(`/api/mail-analyzer/folders/${encodeURIComponent(folderName)}`);
    const data = await res.json();
    setRules(data.rules ?? []);
  }, [folderName]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const patchRule = async (id: number, body: object) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/mail-analyzer/proposals/rule/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("PATCH failed");
      await load();
      onMutate();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Save failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const deleteRule = async (id: number) => {
    if (!confirm("Delete this rule? Existing routed mail stays put.")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/mail-analyzer/proposals/rule/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("DELETE failed");
      await load();
      onMutate();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Delete failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const addRule = async (input: {
    match_type: MatchType;
    match_value: string;
    confidence: number | null;
  }) => {
    setBusy(true);
    try {
      const res = await fetch(
        `/api/mail-analyzer/folders/${encodeURIComponent(folderName)}/rules`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Add failed");
      }
      await load();
      onMutate();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Add failed", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Folder ${folderName}`}
        className="relative flex max-h-[90vh] w-[min(720px,94vw)] flex-col rounded-2xl border border-border bg-background shadow-2xl"
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-5 top-5 rounded-md p-1.5 text-muted hover:bg-[var(--brand-soft)] hover:text-foreground"
        >
          <X size={18} />
        </button>

        <div className="border-b border-border px-8 py-5">
          <h2 className="font-mono text-lg font-semibold tracking-tight">{folderName}</h2>
          <p className="mt-1 text-xs text-muted">
            Rules that route mail into this folder.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              disabled
              title={PHASE3_TOOLTIP}
              className="cursor-not-allowed rounded-md border border-border px-2.5 py-1 text-xs text-muted opacity-60"
            >
              Rename folder
            </button>
            <button
              disabled
              title={PHASE3_TOOLTIP}
              className="cursor-not-allowed rounded-md border border-border px-2.5 py-1 text-xs text-muted opacity-60"
            >
              New sub-folder
            </button>
            <button
              disabled
              title={PHASE3_TOOLTIP}
              className="cursor-not-allowed rounded-md border border-border px-2.5 py-1 text-xs text-muted opacity-60"
            >
              Delete folder
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-8 py-5">
          {rules === null ? (
            <p className="text-sm text-muted">Loading rules…</p>
          ) : rules.length === 0 ? (
            <p className="text-sm text-muted">
              No rules yet. Add one below to start routing mail here.
            </p>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {rules.map((r) => (
                <RuleEditor
                  key={r.id}
                  rule={r}
                  busy={busy}
                  onPatch={(body) => patchRule(r.id, body)}
                  onDelete={() => deleteRule(r.id)}
                />
              ))}
            </div>
          )}

          <div className="mt-6 border-t border-border pt-4">
            <h3 className="mb-2 text-sm font-semibold">Add rule</h3>
            <AddRuleForm busy={busy} onAdd={addRule} />
          </div>
        </div>
      </div>
    </div>
  );
}

function RuleEditor({
  rule,
  busy,
  onPatch,
  onDelete,
}: {
  rule: Rule;
  busy: boolean;
  onPatch: (body: Partial<Rule>) => void;
  onDelete: () => void;
}) {
  // Local form state seeded once per RuleEditor mount. The parent re-mounts
  // this component via `key={r.id}` when the rule list changes; after a save
  // the local values already match the server response, so dirty becomes false
  // without an effect-driven resync.
  const [matchValue, setMatchValue] = useState(rule.match_value);
  const [matchType, setMatchType] = useState<MatchType>(rule.match_type);
  const [target, setTarget] = useState(rule.target_folder ?? "");
  const [confidence, setConfidence] = useState<string>(
    rule.confidence == null ? "" : String(rule.confidence),
  );
  const [showSamples, setShowSamples] = useState(false);

  const dirty =
    matchValue !== rule.match_value ||
    matchType !== rule.match_type ||
    target !== (rule.target_folder ?? "") ||
    confidence !== (rule.confidence == null ? "" : String(rule.confidence));

  const active = rule.status === "accepted";

  const save = () => {
    const body: Record<string, unknown> = {};
    if (matchValue !== rule.match_value) body.match_value = matchValue.trim();
    if (target !== (rule.target_folder ?? "")) body.target_folder = target.trim() || null;
    if (confidence !== (rule.confidence == null ? "" : String(rule.confidence))) {
      const n = confidence.trim() === "" ? null : Number(confidence);
      body.confidence = Number.isFinite(n as number) || n === null ? n : rule.confidence;
    }
    if (Object.keys(body).length === 0) return;
    onPatch(body as Partial<Rule>);
  };

  return (
    <div className="py-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
        <div className="md:col-span-3">
          <label className="block text-xs text-muted">Match type</label>
          <select
            value={matchType}
            onChange={(e) => setMatchType(e.target.value as MatchType)}
            className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          >
            <option value="sender_email">email</option>
            <option value="sender_domain">domain</option>
          </select>
        </div>
        <div className="md:col-span-5">
          <label className="block text-xs text-muted">Match value</label>
          <input
            value={matchValue}
            onChange={(e) => setMatchValue(e.target.value)}
            className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs"
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs text-muted">Confidence</label>
          <input
            type="number"
            step="0.01"
            min="0"
            max="1"
            value={confidence}
            onChange={(e) => setConfidence(e.target.value)}
            placeholder="—"
            className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs tabular-nums"
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs text-muted">Active</label>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              onPatch({ status: active ? "rejected" : "accepted" } as Partial<Rule>)
            }
            className={`mt-1 w-full rounded-md border px-2 py-1.5 text-xs transition-colors ${
              active
                ? "border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand)]"
                : "border-border text-muted hover:text-foreground"
            }`}
          >
            {active ? "Active" : "Inactive"}
          </button>
        </div>
        <div className="md:col-span-12">
          <label className="block text-xs text-muted">Target folder</label>
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="mt-1 w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs"
          />
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-3 text-muted">
          <span>
            Status: <span className="font-mono">{rule.status}</span> · source{" "}
            <span className="font-mono">{rule.source}</span>
          </span>
          {rule.samples.length > 0 && (
            <button
              type="button"
              onClick={() => setShowSamples((v) => !v)}
              className="text-muted transition-colors hover:text-foreground"
            >
              {showSamples ? "Hide" : `Show ${rule.samples.length} sample subject(s)`}
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-muted transition-colors hover:border-danger hover:text-danger"
          >
            <Trash2 size={12} /> Delete
          </button>
          <Button size="sm" disabled={busy || !dirty} onClick={save}>
            Save
          </Button>
        </div>
      </div>

      {showSamples && rule.samples.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-md border border-border bg-card-hover/30 p-3 text-xs">
          {rule.samples.map((s) => (
            <li key={s.id} className="truncate">
              <span className="font-mono text-muted">{s.sender_email}</span>
              {" — "}
              {s.subject || <span className="text-muted">(no subject)</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddRuleForm({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (input: { match_type: MatchType; match_value: string; confidence: number | null }) => void;
}) {
  const [matchType, setMatchType] = useState<MatchType>("sender_domain");
  const [matchValue, setMatchValue] = useState("");
  const [confidence, setConfidence] = useState<string>("");

  const submit = () => {
    const v = matchValue.trim();
    if (!v) return;
    const c = confidence.trim() === "" ? null : Number(confidence);
    onAdd({
      match_type: matchType,
      match_value: v,
      confidence: c == null ? null : Number.isFinite(c) ? c : null,
    });
    setMatchValue("");
    setConfidence("");
  };

  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-12">
      <div className="md:col-span-3">
        <select
          value={matchType}
          onChange={(e) => setMatchType(e.target.value as MatchType)}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
        >
          <option value="sender_domain">domain</option>
          <option value="sender_email">email</option>
        </select>
      </div>
      <div className="md:col-span-5">
        <input
          value={matchValue}
          onChange={(e) => setMatchValue(e.target.value)}
          placeholder={matchType === "sender_email" ? "alice@example.com" : "example.com"}
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 font-mono text-xs"
        />
      </div>
      <div className="md:col-span-2">
        <input
          type="number"
          step="0.01"
          min="0"
          max="1"
          value={confidence}
          onChange={(e) => setConfidence(e.target.value)}
          placeholder="conf"
          className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs tabular-nums"
        />
      </div>
      <div className="md:col-span-2">
        <Button
          size="sm"
          disabled={busy || !matchValue.trim()}
          onClick={submit}
          className="w-full"
        >
          <Plus size={14} /> Add
        </Button>
      </div>
    </div>
  );
}
