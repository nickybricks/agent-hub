"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MetricCard } from "@/components/ui/MetricCard";
import { VolumeChart } from "@/components/ui/VolumeChart";
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

interface Sender {
  sender_email: string;
  sender_name: string;
  domain: string;
  category: string | null;
  message_count: number;
  unread_count: number;
  last_seen: string;
  junk_pct: number;
}

interface Mailbox {
  name: string;
  account: string;
  message_count: number;
  unread_count: number;
  last_scanned_at: string;
  scanned_messages: number;
  total_size_bytes: number;
}

interface VolumeRow {
  day: string;
  message_count: number;
}

interface JunkData {
  topSenders: { sender_email: string; sender_name: string; message_count: number; last_seen: string }[];
  sampleSubjects: { sender_email: string; subject: string; date_received: string }[];
  total: number;
}

interface CategoryRow {
  category: string;
  sender_count: number;
  message_count: number;
}

const CATEGORY_META: Record<string, { color: string; chip: string }> = {
  newsletter:     { color: "var(--cat-newsletter)",    chip: "bg-sky-50 text-sky-600 dark:bg-sky-950 dark:text-sky-300" },
  transactional:  { color: "var(--cat-transactional)", chip: "bg-[var(--brand-soft)] text-[var(--brand)]" },
  personal:       { color: "var(--cat-personal)",      chip: "bg-emerald-50 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-300" },
  promotional:    { color: "var(--cat-promotional)",   chip: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300" },
  notification:   { color: "var(--cat-notification)",  chip: "bg-orange-50 text-orange-600 dark:bg-orange-950 dark:text-orange-300" },
  social:         { color: "var(--cat-social)",        chip: "bg-cyan-50 text-cyan-600 dark:bg-cyan-950 dark:text-cyan-300" },
  work:           { color: "var(--cat-work)",          chip: "bg-violet-50 text-violet-600 dark:bg-violet-950 dark:text-violet-300" },
  other:          { color: "var(--cat-spam)",          chip: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300" },
  unclassified:   { color: "var(--cat-spam)",          chip: "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400" },
};

function CategoryBadge({ category }: { category: string | null }) {
  const c = category ?? "unclassified";
  const meta = CATEGORY_META[c] ?? CATEGORY_META.other;
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${meta.chip}`}>
      {c}
    </span>
  );
}

function fmt(n: number | null | undefined) {
  if (n == null) return "—";
  return n.toLocaleString();
}

function fmtBytes(bytes: number | null | undefined) {
  if (!bytes) return "—";
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString();
}

export default function MailAnalyzerPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [volume, setVolume] = useState<VolumeRow[]>([]);
  const [junk, setJunk] = useState<JunkData | null>(null);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "senders" | "mailboxes" | "junk">("overview");
  const wasRunningRef = useRef(false);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const loadAll = useCallback(async () => {
    const [ov, snd, mb, vol, jk, cats] = await Promise.all([
      fetch("/api/mail-analyzer/overview").then((r) => r.json()),
      fetch(`/api/mail-analyzer/top-senders?category=${categoryFilter}`).then((r) => r.json()),
      fetch("/api/mail-analyzer/mailboxes").then((r) => r.json()),
      fetch("/api/mail-analyzer/volume-by-day").then((r) => r.json()),
      fetch("/api/mail-analyzer/junk").then((r) => r.json()),
      fetch("/api/mail-analyzer/categories").then((r) => r.json()),
    ]);
    setOverview(ov);
    setSenders(snd.senders ?? []);
    setMailboxes(mb.mailboxes ?? []);
    setVolume(vol.rows ?? []);
    setJunk(jk);
    setCategories(cats.categories ?? []);
    setLoading(false);
  }, [categoryFilter]);

  useEffect(() => {
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
      // Give the child a moment to insert its scan_runs row, then refresh overview.
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
      <div className="max-w-[1400px] mx-auto px-8 py-10">
        <p className="text-sm" style={{ color: "var(--muted)" }}>Loading mail analyzer data…</p>
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

  return (
    <div className="max-w-[1400px] mx-auto px-8 py-10">
      <div className="mb-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight mb-1">Mail Analyzer</h1>
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              Read-only analysis of your Apple Mail account.
              {lastRun && !isRunning && (
                <span>
                  {" "}Last scan:{" "}
                  <span className={lastRun.status === "ok" ? "text-success" : "text-danger"}>
                    {lastRun.status}
                  </span>
                  {" "}— {fmt(lastRun.messages_scanned)} messages,{" "}
                  {fmtDate(lastRun.finished_at)}
                </span>
              )}
              {isRunning && (
                <span className="text-accent">
                  {" "}Scanning… {fmt(lastRun?.messages_scanned)} messages so far
                </span>
              )}
            </p>
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
        {isStale && (
          <div className="mt-4 bg-warning-soft border border-border rounded-xl p-3 text-sm">
            Data may be stale (last scan {fmtDate(finishedAt)}). Click <em>Refresh now</em> to re-scan.
          </div>
        )}
        {!hasData && !isRunning && (
          <div className="mt-4 bg-warning-soft border border-border rounded-xl p-4 text-sm">
            No data yet. Run <code className="font-mono bg-background-secondary px-1 rounded">npm run mail:analyze</code> to scan your mailbox, or click <em>Refresh now</em>.
          </div>
        )}
      </div>

      {hasData && (
        <>
          {/* Totals */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <MetricCard label="Total Messages" value={fmt(totals.total_messages)} index={0} />
            <MetricCard label="Unread" value={fmt(totals.unread_messages)} index={1} />
            <MetricCard label="Senders" value={fmt(totals.sender_count)} index={2} />
            <MetricCard label="Mailboxes" value={fmt(totals.mailbox_count)} index={3} />
          </div>

          {/* Date range */}
          <p className="text-xs text-muted mb-6">
            Mail range: {fmtDate(totals.earliest_date)} – {fmtDate(totals.latest_date)}
          </p>

          {/* Tabs */}
          <div className="flex gap-2 mb-6 border-b border-border">
            {(["overview", "senders", "mailboxes", "junk"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-sm font-medium capitalize border-b-2 -mb-px transition-colors ${
                  activeTab === tab
                    ? "border-accent text-accent"
                    : "border-transparent text-muted hover:text-foreground"
                }`}
              >
                {tab === "junk" ? `Junk (${fmt(junk?.total)})` : tab}
              </button>
            ))}
          </div>

          {/* Overview tab: volume chart */}
          {activeTab === "overview" && (
            <div className="card p-5">
              <h2 className="font-semibold mb-4">Volume — last 90 days</h2>
              <VolumeChart data={volume} />
            </div>
          )}

          {/* Senders tab */}
          {activeTab === "senders" && (
            <div className="space-y-4">
              {categories.length > 0 && (
                <div className="card p-5">
                  <h2 className="font-semibold mb-3">Categories</h2>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => setCategoryFilter("all")}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                        categoryFilter === "all"
                          ? "border-accent text-accent bg-accent/10"
                          : "border-border text-muted hover:text-foreground"
                      }`}
                    >
                      All
                    </button>
                    {categories.map((c) => (
                      <button
                        key={c.category}
                        onClick={() => setCategoryFilter(c.category)}
                        className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                          categoryFilter === c.category
                            ? "border-accent text-accent bg-accent/10"
                            : "border-border text-muted hover:text-foreground"
                        }`}
                      >
                        <CategoryBadge category={c.category} />
                        <span className="ml-2">{fmt(c.message_count)} msgs · {fmt(c.sender_count)} senders</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="card overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted">
                      <th className="px-4 py-3 font-medium">Sender</th>
                      <th className="px-4 py-3 font-medium">Category</th>
                      <th className="px-4 py-3 font-medium text-right">Messages</th>
                      <th className="px-4 py-3 font-medium text-right">Unread</th>
                      <th className="px-4 py-3 font-medium text-right">Junk %</th>
                      <th className="px-4 py-3 font-medium">Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {senders.map((s) => (
                      <tr key={s.sender_email} className="border-b border-border last:border-0 hover:bg-card-hover transition-colors">
                        <td className="px-4 py-2">
                          <p className="font-medium truncate max-w-xs">{s.sender_name || s.sender_email}</p>
                          <p className="text-xs text-muted">{s.sender_email}</p>
                        </td>
                        <td className="px-4 py-2">
                          <CategoryBadge category={s.category} />
                        </td>
                        <td className="px-4 py-2 text-right">{fmt(s.message_count)}</td>
                        <td className="px-4 py-2 text-right text-muted">{fmt(s.unread_count)}</td>
                        <td className="px-4 py-2 text-right">
                          {s.junk_pct > 0 ? (
                            <span className="text-danger">{s.junk_pct.toFixed(0)}%</span>
                          ) : "—"}
                        </td>
                        <td className="px-4 py-2 text-muted text-xs">{fmtDate(s.last_seen)}</td>
                      </tr>
                    ))}
                    {senders.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-6 text-center text-muted text-sm">
                          No senders in this category.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Mailboxes tab */}
          {activeTab === "mailboxes" && (
            <div className="card overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted">
                    <th className="px-4 py-3 font-medium">Mailbox</th>
                    <th className="px-4 py-3 font-medium text-right">Scanned</th>
                    <th className="px-4 py-3 font-medium text-right">Unread</th>
                    <th className="px-4 py-3 font-medium text-right">Size</th>
                    <th className="px-4 py-3 font-medium">Last scanned</th>
                  </tr>
                </thead>
                <tbody>
                  {mailboxes.map((mb) => (
                    <tr key={`${mb.account}/${mb.name}`} className="border-b border-border last:border-0 hover:bg-card-hover transition-colors">
                      <td className="px-4 py-2">
                        <p className="font-medium">{mb.name}</p>
                        <p className="text-xs text-muted">{mb.account}</p>
                      </td>
                      <td className="px-4 py-2 text-right">{fmt(mb.scanned_messages)}</td>
                      <td className="px-4 py-2 text-right text-muted">{fmt(mb.unread_count)}</td>
                      <td className="px-4 py-2 text-right text-muted">{fmtBytes(mb.total_size_bytes)}</td>
                      <td className="px-4 py-2 text-muted text-xs">{fmtDate(mb.last_scanned_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Junk tab */}
          {activeTab === "junk" && junk && (
            <div className="space-y-6">
              <div className="card overflow-hidden">
                <div className="px-4 py-3 border-b border-border">
                  <h2 className="font-semibold">Top Junk senders</h2>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted">
                      <th className="px-4 py-3 font-medium">Sender</th>
                      <th className="px-4 py-3 font-medium text-right">Messages</th>
                      <th className="px-4 py-3 font-medium">Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {junk.topSenders.map((s) => (
                      <tr key={s.sender_email} className="border-b border-border last:border-0 hover:bg-card-hover transition-colors">
                        <td className="px-4 py-2">
                          <p className="font-medium truncate max-w-xs">{s.sender_name || s.sender_email}</p>
                          <p className="text-xs text-muted">{s.sender_email}</p>
                        </td>
                        <td className="px-4 py-2 text-right">{fmt(s.message_count)}</td>
                        <td className="px-4 py-2 text-muted text-xs">{fmtDate(s.last_seen)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="card overflow-hidden">
                <div className="px-4 py-3 border-b border-border">
                  <h2 className="font-semibold">Recent Junk subjects</h2>
                </div>
                <div className="divide-y divide-border">
                  {junk.sampleSubjects.map((s, i) => (
                    <div key={i} className="px-4 py-2">
                      <p className="text-sm truncate">{s.subject || "(no subject)"}</p>
                      <p className="text-xs text-muted">{s.sender_email} · {fmtDate(s.date_received)}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
