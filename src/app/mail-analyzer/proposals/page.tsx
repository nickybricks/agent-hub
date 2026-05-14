"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

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

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString();
}

const STATUS_CLASS: Record<string, string> = {
  proposed: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  accepted: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  rejected: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400",
  created: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_CLASS[status] ?? ""}`}>
      {status}
    </span>
  );
}

export default function ProposalsPage() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [makeRule, setMakeRule] = useState(true);
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

  const openPreview = async (ruleId: number) => {
    setPreviewBusy(true);
    setMakeRule(true);
    try {
      const res = await fetch(`/api/mail-analyzer/proposals/preview?ruleId=${ruleId}`);
      const data = (await res.json()) as PreviewPayload;
      setPreview(data);
    } finally {
      setPreviewBusy(false);
    }
  };

  const applyRule = async () => {
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
          data.failed > 0 ? "error" : "success"
        );
      }
      setPreview(null);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Apply failed", "error");
    } finally {
      setApplyBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-[1200px] mx-auto px-8 py-10">
        <p className="text-sm text-muted">Loading proposals…</p>
      </div>
    );
  }

  return (
    <div className="max-w-[1200px] mx-auto px-8 py-10">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight mb-1">Folder Proposals</h1>
          <p className="text-sm text-muted">
            Review the LLM-proposed folder structure. Apply each rule with dry-run preview first.
          </p>
        </div>
      </div>

      {proposals.length === 0 ? (
        <div className="card p-6 text-sm">
          No proposals yet. Run{" "}
          <code className="font-mono bg-background-secondary px-1 rounded">
            npm run mail:propose-structure
          </code>{" "}
          to generate them.
        </div>
      ) : (
        <div className="space-y-4">
          {proposals.map((p) => (
            <div key={p.folder.id} className="card p-5">
              <div className="flex items-center justify-between gap-4 mb-2">
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-semibold">{p.folder.path}</h2>
                  <StatusBadge status={p.folder.status} />
                </div>
                <div className="flex gap-2">
                  {p.folder.status === "proposed" && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => patchFolder(p.folder.id, { status: "rejected" })}
                      >
                        Reject folder
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => patchFolder(p.folder.id, { status: "accepted" })}
                      >
                        Accept folder
                      </Button>
                    </>
                  )}
                </div>
              </div>
              {p.folder.rationale && (
                <p className="text-sm text-muted mb-4">{p.folder.rationale}</p>
              )}

              <div className="overflow-hidden border border-border rounded-lg">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-card-hover/40 text-left text-muted">
                      <th className="px-3 py-2 font-medium">Match</th>
                      <th className="px-3 py-2 font-medium">Value</th>
                      <th className="px-3 py-2 font-medium text-right">Pending</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.rules.map((r) => (
                      <tr key={r.id} className="border-b border-border last:border-0">
                        <td className="px-3 py-2 text-xs text-muted">
                          {r.match_type === "sender_email" ? "email" : "domain"}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">{r.match_value}</td>
                        <td className="px-3 py-2 text-right">{r.pending_count.toLocaleString()}</td>
                        <td className="px-3 py-2">
                          <StatusBadge status={r.status} />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="flex gap-2 justify-end">
                            {r.status !== "rejected" && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => patchRule(r.id, { status: "rejected" })}
                              >
                                Reject
                              </Button>
                            )}
                            {r.pending_count > 0 && r.status !== "rejected" && (
                              <Button
                                variant="primary"
                                size="sm"
                                onClick={() => openPreview(r.id)}
                                disabled={previewBusy}
                              >
                                Preview & Apply
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {p.rules.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-3 py-3 text-center text-muted text-xs">
                          No rules attached to this folder.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Preview modal */}
      {preview && (
        <div
          className="fixed inset-0 z-30 flex items-center justify-center p-4"
          style={{ background: "oklch(0 0 0 / 40%)" }}
          onClick={() => !applyBusy && setPreview(null)}
        >
          <div
            className="card p-6 max-w-2xl w-full max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold mb-1">Dry run — would move {preview.total} message(s)</h3>
            <p className="text-sm text-muted mb-4">
              Rule: <span className="font-mono">{preview.rule.match_type}={preview.rule.match_value}</span>{" "}
              → <span className="font-mono">{preview.rule.target_folder}</span>
            </p>

            <div className="space-y-3 mb-4">
              {preview.groups.map((g) => (
                <div key={g.from_mailbox} className="border border-border rounded-lg p-3">
                  <p className="text-sm font-medium mb-2">
                    From <span className="font-mono">{g.from_mailbox}</span>: {g.count} message(s)
                  </p>
                  <ul className="text-xs text-muted space-y-1">
                    {g.samples.map((s) => (
                      <li key={s.id} className="truncate">
                        {fmtDate(s.date_received)} — {s.sender_email} — {s.subject || "(no subject)"}
                      </li>
                    ))}
                    {g.count > g.samples.length && (
                      <li>… and {g.count - g.samples.length} more</li>
                    )}
                  </ul>
                </div>
              ))}
            </div>

            <label className="flex items-center gap-2 text-sm mb-4">
              <input
                type="checkbox"
                checked={makeRule}
                onChange={(e) => setMakeRule(e.target.checked)}
              />
              Save this as a persistent rule (auto-route future mail).
            </label>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPreview(null)} disabled={applyBusy}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={applyRule} disabled={applyBusy || preview.total === 0}>
                {applyBusy ? "Applying…" : `Apply — move ${preview.total} message(s)`}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
