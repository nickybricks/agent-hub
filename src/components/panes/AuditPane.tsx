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

const KIND_META: Record<Kind, { title: string; blurb: string }> = {
  phishing_risk: {
    title: "High-risk / phishing",
    blurb: "Suspicious TLDs, brand impersonation, urgency one-offs. Suggested: block.",
  },
  false_positive_spam: {
    title: "Probably not spam",
    blurb: "In Spam/Junk but looks legitimate. Toggle any you disagree with.",
  },
  false_negative_inbox: {
    title: "Spam/promo in Inbox",
    blurb: "High-volume promo or unread still in Inbox. Toggle off any to keep.",
  },
  hygiene_stale_sender: {
    title: "Stale senders",
    blurb: "Not opened in 12+ months. Unsubscribe candidates.",
  },
  hygiene_storage_hog: {
    title: "Storage hogs",
    blurb: "Top senders by total size. Review for archival.",
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
  return new Date(iso).toLocaleDateString();
}

export default function AuditPane() {
  const [data, setData] = useState<AuditPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [openKind, setOpenKind] = useState<Kind | null>(null);
  const [openFinding, setOpenFinding] = useState<number | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/mail-analyzer/audit");
    setData((await res.json()) as AuditPayload);
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

  const setOverride = async (
    messageId: string,
    kind: Kind,
    decision: Exclude<Decision, null>,
  ) => {
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

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-8 py-10">
        <p className="text-sm text-muted">Loading audit…</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="mx-auto max-w-3xl px-8 py-10">
        <p className="text-sm text-muted">No data.</p>
      </div>
    );
  }

  const totalFindings = KINDS.reduce((acc, k) => acc + data.findings[k].length, 0);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="mb-1 text-2xl font-semibold tracking-tight">Mailbox audit</h1>
          <p className="text-sm text-muted">
            {totalFindings} finding{totalFindings === 1 ? "" : "s"} across {KINDS.length}{" "}
            sections
            {data.lastRun?.finished_at && <> · last run {fmtDate(data.lastRun.finished_at)}</>}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={runAudit} disabled={running}>
          {running ? "Auditing…" : "Run audit"}
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        {KINDS.map((kind) => {
          const list = data.findings[kind];
          const meta = KIND_META[kind];
          const empty = list.length === 0;
          const open = openKind === kind;
          return (
            <div key={kind} className="card overflow-hidden">
              <button
                disabled={empty}
                onClick={() => {
                  setOpenKind(open ? null : kind);
                  setOpenFinding(null);
                }}
                className={`flex w-full items-center justify-between gap-4 px-5 py-3 text-left ${
                  empty ? "cursor-default" : "transition-colors hover:bg-card-hover/40"
                }`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{meta.title}</p>
                  <p className="mt-0.5 truncate text-xs text-muted">{meta.blurb}</p>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-1 text-sm font-semibold tabular-nums ${
                    empty
                      ? "text-muted"
                      : "bg-[var(--brand-soft)] text-[var(--brand)]"
                  }`}
                >
                  {empty ? "✓" : list.length}
                </span>
              </button>

              {open && !empty && (
                <div className="divide-y divide-border border-t border-border">
                  {list.map((f) => (
                    <FindingRow
                      key={f.id}
                      finding={f}
                      expanded={openFinding === f.id}
                      onToggle={() =>
                        setOpenFinding(openFinding === f.id ? null : f.id)
                      }
                      onDismiss={() => dismissFinding(f.id)}
                      onSetOverride={(messageId, decision) =>
                        setOverride(messageId, kind, decision)
                      }
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
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
    <div className="px-5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {finding.sender_email ?? "(unknown sender)"}
          </div>
          <div className="mt-0.5 text-xs text-muted">
            {finding.message_count} message{finding.message_count === 1 ? "" : "s"} · score{" "}
            {finding.score.toFixed(2)} · suggested{" "}
            <span className="font-mono">{finding.suggested_action}</span>
          </div>
          {finding.reasoning && (
            <div className="mt-1 text-xs text-muted">{finding.reasoning}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {hasMessages && (
            <button
              onClick={onToggle}
              className="text-xs text-muted transition-colors hover:text-foreground"
            >
              {expanded ? "Hide" : "Show"}
            </button>
          )}
          <button
            onClick={onDismiss}
            className="text-xs text-muted transition-colors hover:text-foreground"
          >
            Dismiss
          </button>
        </div>
      </div>

      {expanded && hasMessages && (
        <ul className="mt-3 space-y-1 border-t border-border pt-3 text-sm">
          {finding.messages.map((m) => (
            <li key={m.id} className="flex items-start justify-between gap-3 py-1">
              <div className="min-w-0">
                <div className="truncate">
                  {m.subject || <span className="text-muted">(no subject)</span>}
                </div>
                <div className="text-xs text-muted">
                  {new Date(m.date_received).toLocaleDateString()} ·{" "}
                  <span className="font-mono">{m.mailbox_name}</span>
                  {!m.is_read && " · unread"}
                </div>
              </div>
              <Toggle
                value={m.override}
                kind={finding.kind}
                threeState={showThreeState}
                onChange={(d) => onSetOverride(m.id, d)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Toggle({
  value,
  kind,
  threeState,
  onChange,
}: {
  value: Decision;
  kind: Kind;
  threeState: boolean;
  onChange: (d: Exclude<Decision, null>) => void;
}) {
  const effective: Exclude<Decision, null> = value ?? "include";
  const opts: Exclude<Decision, null>[] = threeState
    ? ["include", "exclude", "agree"]
    : ["include", "exclude"];
  const labels: Record<string, string> = threeState
    ? kind === "false_positive_spam"
      ? { include: "Not spam", exclude: "Actually spam", agree: "Unsure" }
      : { include: "Move out", exclude: "Keep", agree: "Unsure" }
    : { include: "Include", exclude: "Skip" };

  return (
    <div className="flex shrink-0 gap-1 text-xs">
      {opts.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`rounded-md border px-2 py-1 transition-colors ${
            effective === opt
              ? "border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand)]"
              : "border-border text-muted hover:text-foreground"
          }`}
        >
          {labels[opt]}
        </button>
      ))}
    </div>
  );
}
