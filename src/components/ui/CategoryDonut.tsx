"use client";

import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";

export interface CategoryRow {
  category: string;
  message_count: number;
}

// Reuse the category color vars already defined in globals.css.
const KNOWN = new Set([
  "newsletter",
  "transactional",
  "promotional",
  "personal",
  "notification",
  "social",
  "work",
  "spam",
]);

function colorFor(category: string): string {
  return KNOWN.has(category) ? `var(--cat-${category})` : "var(--muted)";
}

export function CategoryDonut({ data }: { data: CategoryRow[] }) {
  // Postgres COUNT() arrives as a string — coerce before any math.
  const rows = data
    .map((d) => ({ category: d.category, message_count: Number(d.message_count) || 0 }))
    .filter((d) => d.message_count > 0)
    .sort((a, b) => b.message_count - a.message_count);
  const total = rows.reduce((s, d) => s + d.message_count, 0);

  if (total === 0) {
    return <p className="text-sm text-muted">No classified mail yet.</p>;
  }

  return (
    <div className="flex flex-col items-center gap-5">
      <div className="relative h-44 w-44 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={rows}
              dataKey="message_count"
              nameKey="category"
              innerRadius={60}
              outerRadius={86}
              paddingAngle={2}
              stroke="none"
              isAnimationActive={false}
            >
              {rows.map((d) => (
                <Cell key={d.category} fill={colorFor(d.category)} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold tabular-nums">{total.toLocaleString()}</span>
          <span className="text-[11px] uppercase tracking-wide text-muted">messages</span>
        </div>
      </div>

      <ul className="flex w-full flex-col gap-2">
        {rows.slice(0, 7).map((d) => (
          <li key={d.category} className="flex items-center gap-2.5 text-sm">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: colorFor(d.category) }}
            />
            <span className="flex-1 truncate capitalize">{d.category}</span>
            <span className="shrink-0 tabular-nums text-muted">
              {d.message_count.toLocaleString()}
            </span>
            <span className="w-10 shrink-0 text-right font-medium tabular-nums">
              {Math.round((d.message_count / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
