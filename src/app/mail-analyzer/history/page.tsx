"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";

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

export default function HistoryPage() {
  const [moves, setMoves] = useState<MoveEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterMailbox, setFilterMailbox] = useState<string>("");
  const [filterRule, setFilterRule] = useState<string>("");

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
      if (filterMailbox && m.from_mailbox !== filterMailbox && m.to_mailbox !== filterMailbox) continue;
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

  return (
    <div className="p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Recent actions</h1>
        <p className="text-sm text-neutral-500">
          Every message move grouped by batch. Undo reverses the moves via the mail provider.
        </p>
      </header>

      {error && <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label>
          Mailbox:{" "}
          <select className="border rounded px-2 py-1" value={filterMailbox} onChange={(e) => setFilterMailbox(e.target.value)}>
            <option value="">All</option>
            {allMailboxes.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <label>
          Rule:{" "}
          <select className="border rounded px-2 py-1" value={filterRule} onChange={(e) => setFilterRule(e.target.value)}>
            <option value="">All</option>
            {allRules.map((r) => (
              <option key={r} value={r}>#{r}</option>
            ))}
          </select>
        </label>
      </div>

      {loading ? (
        <div className="text-sm text-neutral-500">Loading…</div>
      ) : batches.length === 0 ? (
        <div className="text-sm text-neutral-500">No history yet.</div>
      ) : (
        <ul className="space-y-3">
          {batches.map((b) => (
            <li key={b.batch_id} className="rounded border border-neutral-200">
              <div className="flex items-center justify-between gap-3 p-3 bg-neutral-50">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{b.pairs}</div>
                  <div className="text-xs text-neutral-500">
                    {new Date(b.applied_at).toLocaleString()} ·{" "}
                    {b.appliedCount} applied
                    {b.undoneCount > 0 && ` · ${b.undoneCount} undone`}
                    {b.failedCount > 0 && ` · ${b.failedCount} failed`}
                    {" · "}batch <span className="font-mono">{b.batch_id.slice(0, 8)}</span>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy === b.batch_id || b.appliedCount === 0}
                  onClick={() => undo({ batch_id: b.batch_id })}
                >
                  Undo batch
                </Button>
              </div>
              <ul className="divide-y divide-neutral-200 text-sm">
                {b.moves.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-3 p-2 px-3">
                    <div className="min-w-0">
                      <div className="truncate font-mono text-xs">{m.message_id}</div>
                      <div className="truncate text-xs text-neutral-500">
                        {m.from_mailbox} → {m.to_mailbox} ·{" "}
                        <span className={m.status === "applied" ? "text-green-600" : m.status === "undone" ? "text-neutral-400" : "text-red-600"}>
                          {m.status}
                        </span>
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
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
