"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MetricCard } from "@/components/ui/MetricCard";
import { Button } from "@/components/ui/Button";
import { VolumeChart } from "@/components/ui/VolumeChart";
import { CategoryDonut, type CategoryRow } from "@/components/ui/CategoryDonut";
import { useRevalidate } from "@/components/DataSync";

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

interface CategoryStat {
  category: string;
  sender_count: number;
  message_count: number;
}

interface VolumeRow {
  day: string;
  message_count: number;
}

interface TopSender {
  sender_email: string;
  sender_name: string | null;
  message_count: number;
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

export default function HomePane({
  active,
  onNavigate,
}: {
  active: boolean;
  onNavigate: (tab: string) => void;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [categories, setCategories] = useState<CategoryStat[]>([]);
  const [volume, setVolume] = useState<VolumeRow[]>([]);
  const [topSenders, setTopSenders] = useState<TopSender[]>([]);
  const [reviewCount, setReviewCount] = useState(0);
  const [proposalCount, setProposalCount] = useState(0);
  const [topFolder, setTopFolder] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [now, setNow] = useState<number | null>(() => Date.now());
  const wasRunningRef = useRef(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const loadAll = useCallback(async () => {
    // One failing endpoint must never blackhole the whole view: fetch each
    // independently, tolerate non-JSON/errors, always clear loading.
    const get = async (url: string): Promise<Record<string, unknown>> => {
      try {
        return (await (await fetch(url)).json()) as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    try {
      const [ov, cat, vol, snd, rv, pr] = await Promise.all([
        get("/api/mail-analyzer/overview"),
        get("/api/mail-analyzer/categories"),
        get("/api/mail-analyzer/volume-by-day"),
        get("/api/mail-analyzer/top-senders?category=all"),
        get("/api/mail-analyzer/review"),
        get("/api/mail-analyzer/proposals"),
      ]);
      setOverview(ov as unknown as Overview);
      // Postgres COUNT() comes back as a string — coerce to numbers so the
      // health/newsletter math doesn't string-concatenate.
      setCategories(
        (((cat.categories as CategoryStat[]) ?? []).filter(Boolean)).map((c) => ({
          category: c.category,
          sender_count: Number(c.sender_count) || 0,
          message_count: Number(c.message_count) || 0,
        })),
      );
      setVolume(((vol.rows as VolumeRow[]) ?? []).filter(Boolean));
      setTopSenders(((snd.senders as TopSender[]) ?? []).slice(0, 5));
      setReviewCount(((rv.items as unknown[]) ?? []).length);
      const proposals = (pr.proposals as { folder: { path: string }; rules: { status: string }[] }[]) ?? [];
      setProposalCount(
        proposals.reduce((s, p) => s + p.rules.filter((r) => r.status === "proposed").length, 0),
      );
      setTopFolder(
        proposals.find((p) => p.rules.some((r) => r.status === "proposed"))?.folder.path ?? null,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Chat changed something → refresh (deferred while this tab is hidden).
  useRevalidate(active, loadAll);

  // Poll overview every 2s while a scan is running, then reload everything.
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
      <div className="mx-auto max-w-5xl px-8 py-10">
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

  // Derived metrics — all computed from real data, no invented numbers.
  const total = totals?.total_messages ?? 0;
  const unread = totals?.unread_messages ?? 0;
  const unreadRatio = total ? unread / total : 0;
  const newsletterMsgs =
    categories.find((c) => c.category === "newsletter")?.message_count ?? 0;
  const newsletterShare = total ? Math.round((newsletterMsgs / total) * 100) : 0;
  const totalSenders = categories.reduce((s, c) => s + (c.sender_count ?? 0), 0);
  const unclassifiedSenders =
    categories.find((c) => c.category === "unclassified")?.sender_count ?? 0;
  const unclassifiedRatio = totalSenders ? unclassifiedSenders / totalSenders : 0;
  // Health = 100 minus penalties for unread mail and unclassified senders.
  const health = Math.round(
    Math.max(0, Math.min(100, 100 - 60 * unreadRatio - 40 * unclassifiedRatio)),
  );

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
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-8 py-10">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="mb-1 text-2xl font-semibold tracking-tight">
            Your mailbox is breathing.
          </h1>
          <p className="text-sm text-muted">{statusLine}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={triggerScan} disabled={scanning || isRunning}>
          {isRunning || scanning ? "Syncing…" : "Sync now"}
        </Button>
      </div>

      {!hasData && !isRunning ? (
        <div className="rounded-xl border border-border bg-warning-soft p-4 text-sm">
          No data yet. Click <em>Sync now</em> to scan your mailbox, or ask the assistant to get
          started.
        </div>
      ) : (
        <>
          {isStale && (
            <div className="rounded-xl border border-border bg-warning-soft p-3 text-sm">
              Data may be stale (last scan {fmtDate(finishedAt)}). Click <em>Sync now</em> to
              re-scan.
            </div>
          )}

          {/* Key metrics — all real */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <MetricCard label="Messages" value={fmt(total)} index={0} />
            <MetricCard
              label="Newsletter share"
              value={`${newsletterShare}%`}
              hint="of all mail"
              index={1}
            />
            <MetricCard
              label="Health score"
              value={health}
              hint="100 − unread & unclassified penalties"
              index={2}
            />
            <MetricCard
              label="Unread"
              value={`${Math.round(unreadRatio * 100)}%`}
              hint={`${fmt(unread)} messages`}
              index={3}
            />
          </div>

          {/* Inflow + composition */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="card p-5 lg:col-span-2">
              <h2 className="mb-4 text-sm font-semibold">Inbox inflow · last 90 days</h2>
              <VolumeChart data={volume} />
            </div>
            <div className="card p-5">
              <h2 className="mb-4 text-sm font-semibold">Composition</h2>
              <CategoryDonut data={categories as CategoryRow[]} />
            </div>
          </div>

          {/* Attention: review queue + next action */}
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
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {proposalCount > 0
                    ? `${proposalCount} folder proposal${proposalCount === 1 ? "" : "s"}`
                    : "No new proposals"}
                </p>
                <p className="mt-0.5 truncate text-xs text-muted">
                  {proposalCount > 0
                    ? topFolder
                      ? `Next: route mail into “${topFolder}”`
                      : "Review and apply them"
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

          {/* Top senders — compact, not a table */}
          <div className="card overflow-hidden">
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <h2 className="text-sm font-semibold">Top senders</h2>
              {topSenders.length > 0 && (
                <button
                  onClick={() => onNavigate("Audit")}
                  className="text-xs text-muted transition-colors hover:text-foreground"
                >
                  See analysis →
                </button>
              )}
            </div>
            {topSenders.length === 0 ? (
              <p className="px-5 py-6 text-center text-sm text-muted">No senders yet.</p>
            ) : (
              <div className="divide-y divide-border">
                {topSenders.map((s) => {
                  const label = s.sender_name?.trim() || s.sender_email;
                  return (
                    <div
                      key={s.sender_email}
                      className="flex items-center gap-3 px-5 py-2.5 text-sm"
                    >
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--brand-soft)] text-xs font-semibold uppercase text-[var(--brand)]">
                        {label.charAt(0)}
                      </span>
                      <p className="min-w-0 flex-1 truncate">
                        <span className="font-medium">{label}</span>
                        <span className="ml-2 text-xs text-muted">{s.sender_email}</span>
                      </p>
                      <span className="shrink-0 tabular-nums text-muted">
                        {fmt(s.message_count)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
