"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { useRevalidate } from "@/components/DataSync";

interface Rule {
  id: number;
  match_type: "sender_email" | "sender_domain";
  match_value: string;
  action: string;
  target_folder: string | null;
  status: "proposed" | "accepted" | "rejected";
  source: string;
  confidence: number | null;
  last_applied_at: string | null;
  pending_count: number;
}

interface Folder {
  id: number;
  path: string;
  rationale: string | null;
  status: "proposed" | "accepted" | "rejected" | "created";
  created_at: string;
}

interface Proposal {
  folder: Folder;
  rules: Rule[];
}

interface PreviewGroup {
  from_mailbox: string;
  count: number;
  samples: { id: string; subject: string | null; sender_email: string; date_received: string }[];
}

interface PreviewPayload {
  rule: Rule;
  total: number;
  groups: PreviewGroup[];
}

const BADGE_CLASS: Record<string, string> = {
  proposed: "bg-warning-soft text-foreground",
  accepted: "bg-[var(--brand-soft)] text-[var(--brand)]",
  rejected: "bg-card-hover text-muted",
  created: "bg-[var(--brand-soft)] text-[var(--brand)]",
};

function Badge({ status }: { status: string }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${BADGE_CLASS[status] ?? ""}`}
    >
      {status}
    </span>
  );
}

export default function ProposalsPane({ active }: { active: boolean }) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeRule, setActiveRule] = useState<number | null>(null);
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [makeRule, setMakeRule] = useState(true);
  const [dragRule, setDragRule] = useState<number | null>(null);
  const [dropFolder, setDropFolder] = useState<number | null>(null);
  const { toast } = useToast();

  const load = useCallback(async () => {
    const res = await fetch("/api/mail-analyzer/proposals");
    const data = await res.json();
    setProposals(data.proposals ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useRevalidate(active, load);

  const patchFolder = async (id: number, body: object) => {
    await fetch(`/api/mail-analyzer/proposals/folder/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await load();
  };

  const patchRule = async (id: number, body: object) => {
    await fetch(`/api/mail-analyzer/proposals/rule/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await load();
  };

  const openApply = async (ruleId: number) => {
    if (activeRule === ruleId) {
      setActiveRule(null);
      setPreview(null);
      return;
    }
    setActiveRule(ruleId);
    setPreview(null);
    setMakeRule(true);
    setPreviewBusy(true);
    try {
      const res = await fetch(`/api/mail-analyzer/proposals/preview?ruleId=${ruleId}`);
      setPreview((await res.json()) as PreviewPayload);
    } finally {
      setPreviewBusy(false);
    }
  };

  const confirmApply = async () => {
    if (!preview) return;
    setApplyBusy(true);
    try {
      const res = await fetch(`/api/mail-analyzer/proposals/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruleId: preview.rule.id, makeRule }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast(data.error ?? "Apply failed", "error");
      } else {
        toast(
          data.moved > 0
            ? `Moved ${data.moved} message(s)${data.failed ? `, ${data.failed} failed` : ""}.`
            : "Nothing to move.",
          data.failed > 0 ? "error" : "success",
        );
      }
      setActiveRule(null);
      setPreview(null);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Apply failed", "error");
    } finally {
      setApplyBusy(false);
    }
  };

  const reassignRule = async (rule: Rule, folder: Folder) => {
    if (rule.target_folder === folder.path) return;
    await patchRule(rule.id, {
      match_value: rule.match_value,
      target_folder: folder.path,
    });
    toast(`Moved rule to “${folder.path}”.`, "success");
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-8 py-10">
        <p className="text-sm text-muted">Loading proposals…</p>
      </div>
    );
  }

  const pendingRules = proposals.reduce(
    (n, p) => n + p.rules.filter((r) => r.status === "proposed").length,
    0,
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-10">
      <div>
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">Folder proposals</h1>
        <p className="text-sm text-muted">
          {pendingRules > 0
            ? `${pendingRules} rule${pendingRules === 1 ? "" : "s"} waiting. Apply inline, or drag a sender into a different folder.`
            : "Nothing waiting. Proposals appear after a scan."}
        </p>
      </div>

      {proposals.length === 0 ? (
        <div className="rounded-xl border border-border bg-warning-soft p-4 text-sm">
          No proposals yet. Run a scan, or ask the assistant to suggest a folder structure.
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {proposals.map((p) => (
            <div
              key={p.folder.id}
              onDragOver={(e) => {
                e.preventDefault();
                setDropFolder(p.folder.id);
              }}
              onDragLeave={() => setDropFolder((f) => (f === p.folder.id ? null : f))}
              onDrop={() => {
                setDropFolder(null);
                const rule = proposals.flatMap((x) => x.rules).find((r) => r.id === dragRule);
                setDragRule(null);
                if (rule) reassignRule(rule, p.folder);
              }}
              className={`card p-5 transition-colors ${
                dropFolder === p.folder.id ? "ring-2 ring-[var(--brand)]" : ""
              }`}
            >
              <div className="mb-3 flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <h2 className="text-base font-semibold">{p.folder.path}</h2>
                  <Badge status={p.folder.status} />
                </div>
                {p.folder.status === "proposed" && (
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => patchFolder(p.folder.id, { status: "rejected" })}
                    >
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => patchFolder(p.folder.id, { status: "accepted" })}
                    >
                      Accept folder
                    </Button>
                  </div>
                )}
              </div>
              {p.folder.rationale && (
                <p className="mb-3 text-sm text-muted">{p.folder.rationale}</p>
              )}

              {p.rules.length === 0 ? (
                <p className="text-xs text-muted">No senders attached to this folder.</p>
              ) : (
                <div className="divide-y divide-border">
                  {p.rules.map((r) => (
                    <div key={r.id}>
                      <div
                        draggable={r.status !== "rejected"}
                        onDragStart={() => setDragRule(r.id)}
                        onDragEnd={() => setDragRule(null)}
                        className={`flex items-center justify-between gap-3 py-2.5 ${
                          r.status !== "rejected" ? "cursor-grab active:cursor-grabbing" : ""
                        } ${dragRule === r.id ? "opacity-40" : ""}`}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          {r.status !== "rejected" && (
                            <span className="select-none text-muted" aria-hidden>
                              ⠿
                            </span>
                          )}
                          <span className="truncate font-mono text-xs">{r.match_value}</span>
                          <span className="shrink-0 text-xs text-muted">
                            {r.match_type === "sender_email" ? "email" : "domain"}
                          </span>
                          {r.status === "rejected" && <Badge status="rejected" />}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="text-xs text-muted tabular-nums">
                            {r.pending_count.toLocaleString()} pending
                          </span>
                          {r.status !== "rejected" && (
                            <>
                              <button
                                onClick={() => patchRule(r.id, { status: "rejected" })}
                                className="text-xs text-muted transition-colors hover:text-danger"
                              >
                                Reject
                              </button>
                              {r.pending_count > 0 && (
                                <Button
                                  size="sm"
                                  variant={activeRule === r.id ? "ghost" : "primary"}
                                  onClick={() => openApply(r.id)}
                                >
                                  {activeRule === r.id ? "Close" : "Apply"}
                                </Button>
                              )}
                            </>
                          )}
                        </div>
                      </div>

                      {activeRule === r.id && (
                        <div className="mb-2 rounded-lg border border-border bg-card-hover/40 p-3">
                          {previewBusy || !preview ? (
                            <p className="text-xs text-muted">Checking what would move…</p>
                          ) : (
                            <>
                              <p className="mb-2 text-sm">
                                Move <span className="font-semibold">{preview.total}</span>{" "}
                                message(s) into{" "}
                                <span className="font-mono">{preview.rule.target_folder}</span>
                              </p>
                              {preview.groups.length > 0 && (
                                <ul className="mb-3 space-y-1 text-xs text-muted">
                                  {preview.groups.slice(0, 3).flatMap((g) =>
                                    g.samples.slice(0, 2).map((s) => (
                                      <li key={s.id} className="truncate">
                                        {s.sender_email} — {s.subject || "(no subject)"}
                                      </li>
                                    )),
                                  )}
                                  {preview.total > 6 && (
                                    <li>… and {preview.total - 6} more</li>
                                  )}
                                </ul>
                              )}
                              <label className="mb-3 flex items-center gap-2 text-xs">
                                <input
                                  type="checkbox"
                                  checked={makeRule}
                                  onChange={(e) => setMakeRule(e.target.checked)}
                                />
                                Also auto-route future mail from this sender.
                              </label>
                              <div className="flex justify-end gap-2">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    setActiveRule(null);
                                    setPreview(null);
                                  }}
                                  disabled={applyBusy}
                                >
                                  Cancel
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={confirmApply}
                                  disabled={applyBusy || preview.total === 0}
                                >
                                  {applyBusy ? "Applying…" : `Move ${preview.total}`}
                                </Button>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
