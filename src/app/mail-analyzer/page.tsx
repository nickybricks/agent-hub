"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
    const [ov, snd, mb, vol, jk] = await Promise.all([
      fetch("/api/mail-analyzer/overview").then((r) => r.json()),
      fetch("/api/mail-analyzer/top-senders").then((r) => r.json()),
      fetch("/api/mail-analyzer/mailboxes").then((r) => r.json()),
      fetch("/api/mail-analyzer/volume-by-day").then((r) => r.json()),
      fetch("/api/mail-analyzer/junk").then((r) => r.json()),
    ]);
    setOverview(ov);
    setSenders(snd.senders ?? []);
    setMailboxes(mb.mailboxes ?? []);
    setVolume(vol.rows ?? []);
    setJunk(jk);
    setLoading(false);
  }, []);

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

  const maxVolume = Math.max(...volume.map((r) => r.message_count), 1);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-8">
        <p className="text-muted text-sm">Loading mail analyzer data...</p>
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
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold mb-1">Mail Analyzer</h1>
            <p className="text-muted text-sm">
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
          <button
            onClick={triggerScan}
            disabled={scanning || isRunning}
            className="px-3 py-1.5 text-sm rounded-lg border border-border bg-card hover:bg-card-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isRunning || scanning ? "Scanning…" : "Refresh now"}
          </button>
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
            {[
              { label: "Total Messages", value: fmt(totals.total_messages) },
              { label: "Unread", value: fmt(totals.unread_messages) },
              { label: "Senders", value: fmt(totals.sender_count) },
              { label: "Mailboxes", value: fmt(totals.mailbox_count) },
            ].map((stat) => (
              <div key={stat.label} className="bg-card border border-border rounded-xl p-4 shadow-sm shadow-shadow">
                <p className="text-xs text-muted mb-1">{stat.label}</p>
                <p className="text-2xl font-bold">{stat.value}</p>
              </div>
            ))}
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
            <div className="bg-card border border-border rounded-xl p-5 shadow-sm shadow-shadow">
              <h2 className="font-semibold mb-4">Volume — last 90 days</h2>
              {volume.length === 0 ? (
                <p className="text-muted text-sm">No data.</p>
              ) : (
                <div className="flex items-end gap-px h-32 overflow-x-auto">
                  {volume.map((row) => (
                    <div
                      key={row.day}
                      title={`${row.day}: ${row.message_count}`}
                      className="flex-1 min-w-[4px] bg-accent/60 hover:bg-accent rounded-t transition-colors"
                      style={{ height: `${Math.max(2, (row.message_count / maxVolume) * 100)}%` }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Senders tab */}
          {activeTab === "senders" && (
            <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm shadow-shadow">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted">
                    <th className="px-4 py-3 font-medium">Sender</th>
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
                </tbody>
              </table>
            </div>
          )}

          {/* Mailboxes tab */}
          {activeTab === "mailboxes" && (
            <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm shadow-shadow">
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
              <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm shadow-shadow">
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

              <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm shadow-shadow">
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
