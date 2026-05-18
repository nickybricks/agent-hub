"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useRevalidate } from "@/components/DataSync";

interface MoveEntry {
  id: number;
  message_id: string;
  from_mailbox: string;
  to_mailbox: string;
  account: string;
  provider: string;
  rule_id: number | null;
  batch_id: string;
  reason: string | null;
  status: "applied" | "undone" | "failed";
  applied_at: string;
  undone_at: string | null;
  error: string | null;
}

interface Batch {
  batch_id: string;
  applied_at: string;
  moves: MoveEntry[];
  appliedCount: number;
  undoneCount: number;
  failedCount: number;
  pairs: string;
}

export default function HistoryPane({ active }: { active: boolean }) {
  const [moves, setMoves] = useState<MoveEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterMailbox, setFilterMailbox] = useState<string>("");
  const [filterRule, setFilterRule] = useState<string>("");
  const [openBatch, setOpenBatch] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/mail-analyzer/history");
      const j = await r.json();
      setMoves(j.moves ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useRevalidate(active, load);

  async function undo(args: { batch_id?: string; move_id?: number }) {
    const key = args.batch_id ?? args.move_id ?? null;
    setBusy(key);
    setError(null);
    try {
      const r = await fetch("/api/mail-analyzer/history/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "undo failed");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const batches: Batch[] = useMemo(() => {
    const byBatch = new Map<string, MoveEntry[]>();
    for (const m of moves) {
      if (filterMailbox && m.from_mailbox !== filterMailbox && m.to_mailbox !== filterMailbox)
        continue;
      if (filterRule && String(m.rule_id ?? "") !== filterRule) continue;
      const arr = byBatch.get(m.batch_id) ?? [];
      arr.push(m);
      byBatch.set(m.batch_id, arr);
    }
    return Array.from(byBatch.entries())
      .map(([batch_id, items]) => {
        const pairCounts = new Map<string, number>();
        for (const it of items) {
          const k = `${it.from_mailbox} → ${it.to_mailbox}`;
          pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1);
        }
        const pairs = Array.from(pairCounts.entries())
          .map(([p, n]) => `${p} (${n})`)
          .join(", ");
        return {
          batch_id,
          applied_at: items[0].applied_at,
          moves: items,
          appliedCount: items.filter((i) => i.status === "applied").length,
          undoneCount: items.filter((i) => i.status === "undone").length,
          failedCount: items.filter((i) => i.status === "failed").length,
          pairs,
        };
      })
      .sort((a, b) => (a.applied_at < b.applied_at ? 1 : -1));
  }, [moves, filterMailbox, filterRule]);

  const allMailboxes = useMemo(() => {
    const set = new Set<string>();
    for (const m of moves) {
      set.add(m.from_mailbox);
      set.add(m.to_mailbox);
    }
    return Array.from(set).sort();
  }, [moves]);

  const allRules = useMemo(() => {
    const set = new Set<string>();
    for (const m of moves) {
      if (m.rule_id !== null) set.add(String(m.rule_id));
    }
    return Array.from(set).sort();
  }, [moves]);

  const statusColor = (s: MoveEntry["status"]) =>
    s === "applied" ? "text-success" : s === "undone" ? "text-muted" : "text-danger";

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-10">
      <div>
        <h1 className="mb-1 text-2xl font-semibold tracking-tight">Recent actions</h1>
        <p className="text-sm text-muted">
          Message moves grouped by batch. Undo reverses them via the mail provider.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-border bg-warning-soft p-3 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2 text-muted">
          Mailbox
          <select
            className="rounded-md border border-border bg-transparent px-2 py-1 text-foreground"
            value={filterMailbox}
            onChange={(e) => setFilterMailbox(e.target.value)}
          >
            <option value="">All</option>
            {allMailboxes.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-muted">
          Rule
          <select
            className="rounded-md border border-border bg-transparent px-2 py-1 text-foreground"
            value={filterRule}
            onChange={(e) => setFilterRule(e.target.value)}
          >
            <option value="">All</option>
            {allRules.map((r) => (
              <option key={r} value={r}>
                #{r}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : batches.length === 0 ? (
        <div className="rounded-xl border border-border bg-warning-soft p-4 text-sm">
          No history yet. Applied proposals show up here.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {batches.map((b) => {
            const open = openBatch === b.batch_id;
            return (
              <div key={b.batch_id} className="card overflow-hidden">
                <div className="flex items-center justify-between gap-3 px-5 py-3">
                  <button
                    onClick={() => setOpenBatch(open ? null : b.batch_id)}
                    className="min-w-0 text-left transition-colors hover:text-foreground"
                  >
                    <div className="truncate text-sm font-medium">{b.pairs}</div>
                    <div className="mt-0.5 text-xs text-muted">
                      {new Date(b.applied_at).toLocaleString()} · {b.appliedCount} applied
                      {b.undoneCount > 0 && ` · ${b.undoneCount} undone`}
                      {b.failedCount > 0 && ` · ${b.failedCount} failed`} ·{" "}
                      {open ? "hide" : "show"} {b.moves.length}
                    </div>
                  </button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === b.batch_id || b.appliedCount === 0}
                    onClick={() => undo({ batch_id: b.batch_id })}
                  >
                    Undo batch
                  </Button>
                </div>
                {open && (
                  <ul className="divide-y divide-border border-t border-border text-sm">
                    {b.moves.map((m) => (
                      <li
                        key={m.id}
                        className="flex items-center justify-between gap-3 px-5 py-2"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-mono text-xs">{m.message_id}</div>
                          <div className="truncate text-xs text-muted">
                            {m.from_mailbox} → {m.to_mailbox} ·{" "}
                            <span className={statusColor(m.status)}>{m.status}</span>
                            {m.rule_id !== null && ` · rule #${m.rule_id}`}
                            {m.reason && ` · ${m.reason}`}
                          </div>
                        </div>
                        {m.status === "applied" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy === m.id}
                            onClick={() => undo({ move_id: m.id })}
                          >
                            Undo
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
