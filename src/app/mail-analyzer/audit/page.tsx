"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";

type Kind =
  | "false_positive_spam"
  | "false_negative_inbox"
  | "phishing_risk"
  | "hygiene_stale_sender"
  | "hygiene_storage_hog";

type Decision = "include" | "exclude" | "agree" | null;

interface MessageDetail {
  id: string;
  subject: string | null;
  date_received: string;
  is_read: number;
  mailbox_name: string;
  override: Decision;
}

interface Finding {
  id: number;
  kind: Kind;
  sender_email: string | null;
  suggested_action: string;
  score: number;
  reasoning: string | null;
  created_at: string;
  message_count: number;
  messages: MessageDetail[];
}

interface AuditPayload {
  findings: Record<Kind, Finding[]>;
  lastRun: {
    id: number;
    started_at: string;
    finished_at: string | null;
    findings_count: number | null;
    status: string;
  } | null;
}

const KIND_META: Record<Kind, { title: string; blurb: string; positive: "include" | "exclude"; negative: "include" | "exclude" }> = {
  phishing_risk: {
    title: "High-risk / phishing",
    blurb: "Senders matching phishing heuristics (suspicious TLD, brand impersonation, homoglyph, urgency one-offs). Suggested action: block.",
    positive: "include",
    negative: "exclude",
  },
  false_positive_spam: {
    title: "Probably not spam",
    blurb: "Messages currently in Spam/Junk that look legitimate. Toggle individual messages off if you disagree.",
    positive: "include",
    negative: "exclude",
  },
  false_negative_inbox: {
    title: "Spam/promo accumulating in Inbox",
    blurb: "High-volume promotional or unread mail still in Inbox. Toggle off any you want to keep.",
    positive: "include",
    negative: "exclude",
  },
  hygiene_stale_sender: {
    title: "Stale senders",
    blurb: "Senders you haven't opened in 12+ months. Unsubscribe candidates.",
    positive: "include",
    negative: "exclude",
  },
  hygiene_storage_hog: {
    title: "Storage hogs",
    blurb: "Top senders by total size. Review for archival.",
    positive: "include",
    negative: "exclude",
  },
};

const KINDS: Kind[] = [
  "phishing_risk",
  "false_positive_spam",
  "false_negative_inbox",
  "hygiene_stale_sender",
  "hygiene_storage_hog",
];

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export default function AuditPage() {
  const [data, setData] = useState<AuditPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  const load = useCallback(async () => {
    const res = await fetch("/api/mail-analyzer/audit");
    const json = (await res.json()) as AuditPayload;
    setData(json);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const runAudit = async () => {
    setRunning(true);
    try {
      await fetch("/api/mail-analyzer/audit", { method: "POST" });
      await load();
    } finally {
      setRunning(false);
    }
  };

  const dismissFinding = async (id: number) => {
    await fetch("/api/mail-analyzer/audit/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await load();
  };

  const setOverride = async (messageId: string, kind: Kind, decision: Exclude<Decision, null>) => {
    // Optimistic update
    setData((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev) as AuditPayload;
      for (const f of next.findings[kind]) {
        const msg = f.messages.find((m) => m.id === messageId);
        if (msg) msg.override = decision;
      }
      return next;
    });
    await fetch("/api/mail-analyzer/audit/override", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId, kind, decision }),
    });
  };

  if (loading) return <div className="p-8">Loading audit…</div>;
  if (!data) return <div className="p-8">No data.</div>;

  const totalFindings = KINDS.reduce((acc, k) => acc + data.findings[k].length, 0);

  return (
    <div className="p-6 md:p-10 max-w-6xl mx-auto space-y-8">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Mailbox audit</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {totalFindings} finding{totalFindings === 1 ? "" : "s"} across {KINDS.length} sections.
            {data.lastRun?.finished_at && (
              <> Last run {fmtDate(data.lastRun.finished_at)}.</>
            )}
          </p>
        </div>
        <Button onClick={runAudit} disabled={running}>
          {running ? "Auditing…" : "Run audit"}
        </Button>
      </header>

      {KINDS.map((kind) => {
        const list = data.findings[kind];
        const meta = KIND_META[kind];
        return (
          <section key={kind} className="space-y-3">
            <div>
              <h2 className="text-lg font-semibold">
                {meta.title}{" "}
                <span className="text-sm font-normal text-muted-foreground">
                  ({list.length})
                </span>
              </h2>
              <p className="text-sm text-muted-foreground">{meta.blurb}</p>
            </div>

            {list.length === 0 ? (
              <div className="card p-4 text-sm text-muted-foreground">
                Nothing flagged. ✓
              </div>
            ) : (
              <ul className="space-y-2">
                {list.map((f) => (
                  <li key={f.id} className="card p-4">
                    <FindingRow
                      finding={f}
                      expanded={!!expanded[f.id]}
                      onToggle={() =>
                        setExpanded((e) => ({ ...e, [f.id]: !e[f.id] }))
                      }
                      onDismiss={() => dismissFinding(f.id)}
                      onSetOverride={(messageId, decision) =>
                        setOverride(messageId, kind, decision)
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function FindingRow({
  finding,
  expanded,
  onToggle,
  onDismiss,
  onSetOverride,
}: {
  finding: Finding;
  expanded: boolean;
  onToggle: () => void;
  onDismiss: () => void;
  onSetOverride: (messageId: string, decision: Exclude<Decision, null>) => void;
}) {
  const hasMessages = finding.messages.length > 0;
  const showThreeState =
    finding.kind === "false_positive_spam" || finding.kind === "false_negative_inbox";

  return (
    <div>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="font-medium truncate">
            {finding.sender_email ?? "(unknown sender)"}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {finding.message_count} message
            {finding.message_count === 1 ? "" : "s"} · score{" "}
            {finding.score.toFixed(2)} · suggested:{" "}
            <span className="font-mono">{finding.suggested_action}</span>
          </div>
          {finding.reasoning && (
            <div className="text-xs text-muted-foreground mt-1">{finding.reasoning}</div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {hasMessages && (
            <Button variant="ghost" size="sm" onClick={onToggle}>
              {expanded ? "Hide" : "Show"} messages
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
          <Button
            size="sm"
            disabled
            title="Phase 3 — writes not enabled yet"
          >
            Apply
          </Button>
        </div>
      </div>

      {expanded && hasMessages && (
        <ul className="mt-3 border-t pt-3 space-y-1 text-sm">
          {finding.messages.map((m) => (
            <li
              key={m.id}
              className="flex items-start justify-between gap-3 py-1"
            >
              <div className="min-w-0">
                <div className="truncate">
                  {m.subject || <span className="text-muted-foreground">(no subject)</span>}
                </div>
                <div className="text-xs text-muted-foreground">
                  {new Date(m.date_received).toLocaleDateString()} ·{" "}
                  <span className="font-mono">{m.mailbox_name}</span>
                  {!m.is_read && " · unread"}
                </div>
              </div>
              {showThreeState ? (
                <ThreeStateToggle
                  value={m.override}
                  kind={finding.kind}
                  onChange={(d) => onSetOverride(m.id, d)}
                />
              ) : (
                <TwoStateToggle
                  value={m.override}
                  onChange={(d) => onSetOverride(m.id, d)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ThreeStateToggle({
  value,
  kind,
  onChange,
}: {
  value: Decision;
  kind: Kind;
  onChange: (d: Exclude<Decision, null>) => void;
}) {
  const labels =
    kind === "false_positive_spam"
      ? { include: "Not spam", exclude: "Actually spam", agree: "Unsure" }
      : { include: "Move out", exclude: "Keep in Inbox", agree: "Unsure" };
  const effective: Exclude<Decision, null> = value ?? "include";
  return (
    <div className="flex gap-1 text-xs">
      {(["include", "exclude", "agree"] as const).map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`px-2 py-1 rounded-md border ${
            effective === opt
              ? "bg-[var(--brand-soft)] text-[var(--brand)] border-[var(--brand)]"
              : "border-transparent hover:bg-muted"
          }`}
        >
          {labels[opt]}
        </button>
      ))}
    </div>
  );
}

function TwoStateToggle({
  value,
  onChange,
}: {
  value: Decision;
  onChange: (d: Exclude<Decision, null>) => void;
}) {
  const effective: Exclude<Decision, null> = value ?? "include";
  return (
    <div className="flex gap-1 text-xs">
      {(["include", "exclude"] as const).map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`px-2 py-1 rounded-md border ${
            effective === opt
              ? "bg-[var(--brand-soft)] text-[var(--brand)] border-[var(--brand)]"
              : "border-transparent hover:bg-muted"
          }`}
        >
          {opt === "include" ? "Include" : "Skip"}
        </button>
      ))}
    </div>
  );
}
