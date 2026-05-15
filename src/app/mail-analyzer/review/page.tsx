"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";

type Reason =
  | "unknown_sender"
  | "low_confidence"
  | "proposed_rule"
  | "probably_not_spam"
  | "probably_spam";

type Action = "confirm_move" | "keep_inbox" | "mark_spam" | "not_spam" | "create_rule";

interface ReviewItem {
  id: number;
  message_id: string;
  reason: Reason;
  suggested_action: string | null;
  suggested_target: string | null;
  subject: string | null;
  sender_email: string;
  sender_name: string | null;
  mailbox_name: string;
  account: string | null;
  date_received: string;
  created_at: string;
}

const REASON_META: Record<Reason, { title: string; blurb: string }> = {
  unknown_sender: {
    title: "Unknown senders",
    blurb: "No category or rule yet. Decide what to do, optionally make a rule.",
  },
  low_confidence: {
    title: "Low-confidence routing",
    blurb: "Sender has a category but no rule. Confirm or create one.",
  },
  proposed_rule: {
    title: "Pending rule proposals",
    blurb: "There's a proposed rule for this sender — confirm to start auto-routing.",
  },
  probably_not_spam: {
    title: "Probably not spam (recover)",
    blurb: "In Spam/Junk but flagged by the audit as a likely false positive.",
  },
  probably_spam: {
    title: "Probably spam (in Inbox)",
    blurb: "In Inbox but flagged by the audit as likely spam.",
  },
};

const REASON_ORDER: Reason[] = [
  "proposed_rule",
  "probably_not_spam",
  "probably_spam",
  "unknown_sender",
  "low_confidence",
];

export default function ReviewPage() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ruleDraft, setRuleDraft] = useState<{ id: number; target: string; matchType: "sender_email" | "sender_domain" } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/mail-analyzer/review");
      const j = await r.json();
      setItems(j.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(id: number, action: Action, extra?: Partial<{ target: string; ruleMatchType: "sender_email" | "sender_domain" }>) {
    setBusyId(id);
    setError(null);
    try {
      const r = await fetch(`/api/mail-analyzer/review/${id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "decide failed");
      setItems((prev) => prev.filter((x) => x.id !== id));
      setRuleDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  const groups = REASON_ORDER.map((reason) => ({
    reason,
    rows: items.filter((i) => i.reason === reason),
  })).filter((g) => g.rows.length > 0);

  return (
    <div className="p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Review queue</h1>
        <p className="text-sm text-neutral-500">
          Decisions for new mail that the triage daemon couldn&apos;t route automatically.
        </p>
      </header>

      {error && <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      {loading ? (
        <div className="text-sm text-neutral-500">Loading…</div>
      ) : groups.length === 0 ? (
        <div className="text-sm text-neutral-500">Queue is empty.</div>
      ) : (
        groups.map((g) => (
          <section key={g.reason} className="space-y-2">
            <h2 className="text-lg font-medium">{REASON_META[g.reason].title} ({g.rows.length})</h2>
            <p className="text-xs text-neutral-500">{REASON_META[g.reason].blurb}</p>
            <ul className="divide-y divide-neutral-200 rounded border border-neutral-200">
              {g.rows.map((row) => (
                <li key={row.id} className="p-3 space-y-2">
                  <div className="flex items-baseline justify-between gap-4">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{row.subject ?? "(no subject)"}</div>
                      <div className="truncate text-xs text-neutral-500">
                        {row.sender_name ? `${row.sender_name} <${row.sender_email}>` : row.sender_email}
                        {" · "}
                        {row.mailbox_name}
                      </div>
                    </div>
                    <div className="shrink-0 text-xs text-neutral-400">
                      {new Date(row.date_received).toLocaleDateString()}
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {row.suggested_target && (
                      <Button
                        size="sm"
                        disabled={busyId === row.id}
                        onClick={() => decide(row.id, "confirm_move", { target: row.suggested_target! })}
                      >
                        Confirm move → {row.suggested_target}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" disabled={busyId === row.id} onClick={() => decide(row.id, "keep_inbox")}>
                      Keep here
                    </Button>
                    {g.reason !== "probably_not_spam" && (
                      <Button size="sm" variant="ghost" disabled={busyId === row.id} onClick={() => decide(row.id, "mark_spam")}>
                        Mark as spam
                      </Button>
                    )}
                    {g.reason === "probably_not_spam" && (
                      <Button size="sm" variant="ghost" disabled={busyId === row.id} onClick={() => decide(row.id, "not_spam")}>
                        Not spam (move to Inbox)
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyId === row.id}
                      onClick={() =>
                        setRuleDraft({
                          id: row.id,
                          target: row.suggested_target ?? "",
                          matchType: "sender_email",
                        })
                      }
                    >
                      Create rule…
                    </Button>
                  </div>

                  {ruleDraft?.id === row.id && (
                    <div className="rounded border border-neutral-200 bg-neutral-50 p-3 text-sm space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <label className="text-xs">Match</label>
                        <select
                          className="border rounded px-2 py-1 text-xs"
                          value={ruleDraft.matchType}
                          onChange={(e) =>
                            setRuleDraft({ ...ruleDraft, matchType: e.target.value as "sender_email" | "sender_domain" })
                          }
                        >
                          <option value="sender_email">{row.sender_email}</option>
                          <option value="sender_domain">@{row.sender_email.split("@")[1]}</option>
                        </select>
                        <label className="text-xs">→</label>
                        <input
                          className="border rounded px-2 py-1 text-xs flex-1 min-w-[12rem]"
                          placeholder="Target folder (e.g. Newsletters/Tech)"
                          value={ruleDraft.target}
                          onChange={(e) => setRuleDraft({ ...ruleDraft, target: e.target.value })}
                        />
                        <Button
                          size="sm"
                          disabled={!ruleDraft.target.trim() || busyId === row.id}
                          onClick={() =>
                            decide(row.id, "create_rule", {
                              target: ruleDraft.target.trim(),
                              ruleMatchType: ruleDraft.matchType,
                            })
                          }
                        >
                          Create + move
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRuleDraft(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
