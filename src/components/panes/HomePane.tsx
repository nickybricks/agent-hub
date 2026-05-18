"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MetricCard } from "@/components/ui/MetricCard";
import { Button } from "@/components/ui/Button";

interface Overview {
  totals: {
    total_messages: number;
    unread_messages: number;
    mailbox_count: number;
    sender_count: number;
    latest_date: string;
    earliest_date: string;
  } | null;
  lastRun: {
    started_at: string;
    finished_at: string | null;
    messages_scanned: number | null;
    watermark_date: string | null;
    status: string;
  } | null;
}

interface Move {
  id: number;
  from_mailbox: string;
  to_mailbox: string;
  status: "applied" | "undone" | "failed";
  applied_at: string;
}

function fmt(n: number | null | undefined) {
  if (n == null) return "—";
  return n.toLocaleString();
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString();
}

function fmtRelative(iso: string | null | undefined, now: number | null) {
  if (!iso || now == null) return "—";
  const diff = now - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return fmtDate(iso);
}

export default function HomePane({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [reviewCount, setReviewCount] = useState(0);
  const [proposalCount, setProposalCount] = useState(0);
  const [moves, setMoves] = useState<Move[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [now, setNow] = useState<number | null>(() => Date.now());
  const wasRunningRef = useRef(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const loadAll = useCallback(async () => {
    // One failing/500 endpoint must never blackhole the whole Home view:
    // fetch each independently, tolerate non-JSON/errors, always clear loading.
    const get = async (url: string): Promise<Record<string, unknown>> => {
      try {
        const r = await fetch(url);
        return (await r.json()) as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    try {
      const [ov, rv, pr, hist] = await Promise.all([
        get("/api/mail-analyzer/overview"),
        get("/api/mail-analyzer/review"),
        get("/api/mail-analyzer/proposals"),
        get("/api/mail-analyzer/history?limit=6"),
      ]);
      setOverview(ov as unknown as Overview);
      setReviewCount(((rv.items as unknown[]) ?? []).length);
      const pending = (
        (pr.proposals as { rules: { status: string }[] }[]) ?? []
      ).reduce((sum, p) => sum + p.rules.filter((r) => r.status === "proposed").length, 0);
      setProposalCount(pending);
      setMoves(
        (((hist.moves as Move[]) ?? []).filter((m) => m.status === "applied")).slice(0, 6),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // loadAll only setStates after an awaited fetch, so this is not a
    // synchronous cascading render.
    loadAll();
  }, [loadAll]);

  // Poll overview every 2s while a scan is running, then reload everything on finish.
  useEffect(() => {
    const running = overview?.lastRun?.status === "running";
    if (!running) {
      if (wasRunningRef.current) {
        wasRunningRef.current = false;
        loadAll();
      }
      return;
    }
    wasRunningRef.current = true;
    const t = setInterval(async () => {
      const ov = await fetch("/api/mail-analyzer/overview").then((r) => r.json());
      setOverview(ov);
    }, 2000);
    return () => clearInterval(t);
  }, [overview?.lastRun?.status, loadAll]);

  const triggerScan = async () => {
    setScanning(true);
    try {
      await fetch("/api/mail-analyzer/scan", { method: "POST" });
      setTimeout(async () => {
        const ov = await fetch("/api/mail-analyzer/overview").then((r) => r.json());
        setOverview(ov);
        setScanning(false);
      }, 1500);
    } catch {
      setScanning(false);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-8 py-10">
        <p className="text-sm text-muted">Loading…</p>
      </div>
    );
  }

  const totals = overview?.totals;
  const lastRun = overview?.lastRun;
  const hasData = totals && totals.total_messages > 0;
  const isRunning = lastRun?.status === "running";
  const finishedAt = lastRun?.finished_at;
  const isStale =
    !isRunning &&
    !!finishedAt &&
    now !== null &&
    now - new Date(finishedAt).getTime() > 60 * 60 * 1000;

  let statusLine: React.ReactNode = "No scan yet.";
  if (isRunning) {
    statusLine = (
      <span className="text-accent">
        Scanning… {fmt(lastRun?.messages_scanned)} messages so far
      </span>
    );
  } else if (lastRun) {
    statusLine = (
      <>
        Last scan{" "}
        <span className={lastRun.status === "ok" ? "text-success" : "text-danger"}>
          {lastRun.status}
        </span>{" "}
        · {fmtRelative(lastRun.finished_at, now)}
      </>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-10">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="mb-1 text-2xl font-semibold tracking-tight">Your mailbox</h1>
          <p className="text-sm text-muted">{statusLine}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={triggerScan}
          disabled={scanning || isRunning}
        >
          {isRunning || scanning ? "Scanning…" : "Refresh now"}
        </Button>
      </div>

      {!hasData && !isRunning ? (
        <div className="rounded-xl border border-border bg-warning-soft p-4 text-sm">
          No data yet. Click <em>Refresh now</em> to scan your mailbox, or ask the assistant
          to get started.
        </div>
      ) : (
        <>
          {isStale && (
            <div className="rounded-xl border border-border bg-warning-soft p-3 text-sm">
              Data may be stale (last scan {fmtDate(finishedAt)}). Click{" "}
              <em>Refresh now</em> to re-scan.
            </div>
          )}

          {/* Key counts */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <MetricCard label="Messages" value={fmt(totals?.total_messages)} index={0} />
            <MetricCard label="Unread" value={fmt(totals?.unread_messages)} index={1} />
            <MetricCard label="Senders" value={fmt(totals?.sender_count)} index={2} />
            <MetricCard label="Mailboxes" value={fmt(totals?.mailbox_count)} index={3} />
          </div>

          {/* Attention: review queue + proposals */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="card flex items-center justify-between gap-4 p-5">
              <div>
                <p className="text-sm font-medium">
                  {reviewCount > 0
                    ? `${reviewCount} email${reviewCount === 1 ? "" : "s"} need a decision`
                    : "Nothing waiting for a decision"}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {reviewCount > 0
                    ? "Ask the assistant to walk through them →"
                    : "You're all caught up."}
                </p>
              </div>
              {reviewCount > 0 && (
                <span className="shrink-0 rounded-full bg-[var(--brand-soft)] px-2.5 py-1 text-sm font-semibold text-[var(--brand)] tabular-nums">
                  {reviewCount}
                </span>
              )}
            </div>

            <div className="card flex items-center justify-between gap-4 p-5">
              <div>
                <p className="text-sm font-medium">
                  {proposalCount > 0
                    ? `${proposalCount} folder proposal${proposalCount === 1 ? "" : "s"}`
                    : "No new proposals"}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {proposalCount > 0
                    ? "Review and apply them"
                    : "Proposals appear after a scan."}
                </p>
              </div>
              {proposalCount > 0 && (
                <Button size="sm" onClick={() => onNavigate("Proposals")}>
                  Review
                </Button>
              )}
            </div>
          </div>

          {/* Recent moves */}
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <h2 className="text-sm font-semibold">Recent moves</h2>
              {moves.length > 0 && (
                <button
                  onClick={() => onNavigate("History")}
                  className="text-xs text-muted transition-colors hover:text-foreground"
                >
                  View all →
                </button>
              )}
            </div>
            {moves.length === 0 ? (
              <p className="px-5 py-6 text-center text-sm text-muted">
                No moves yet. Applied proposals show up here.
              </p>
            ) : (
              <div className="divide-y divide-border">
                {moves.map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center justify-between gap-4 px-5 py-2.5 text-sm"
                  >
                    <p className="min-w-0 truncate">
                      <span className="text-muted">{m.from_mailbox}</span>
                      <span className="mx-2 text-muted">→</span>
                      <span className="font-medium">{m.to_mailbox}</span>
                    </p>
                    <span className="shrink-0 text-xs text-muted">
                      {fmtRelative(m.applied_at, now)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
