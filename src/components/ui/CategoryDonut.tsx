"use client";

import { useState } from "react";
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
  const [hover, setHover] = useState<number | null>(null);

  if (total === 0) {
    return <p className="text-sm text-muted">No classified mail yet.</p>;
  }

  const active = hover != null ? rows[hover] : null;

  return (
    <div className="flex flex-col items-center">
      <div className="relative h-56 w-56">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={rows}
              dataKey="message_count"
              nameKey="category"
              innerRadius={70}
              outerRadius={100}
              paddingAngle={2}
              stroke="none"
              isAnimationActive={false}
              onMouseLeave={() => setHover(null)}
            >
              {rows.map((d, i) => (
                <Cell
                  key={d.category}
                  fill={colorFor(d.category)}
                  opacity={hover == null || hover === i ? 1 : 0.3}
                  onMouseEnter={() => setHover(i)}
                  style={{ transition: "opacity 120ms", cursor: "pointer" }}
                />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
          {active ? (
            <>
              <span
                className="text-sm font-semibold capitalize"
                style={{ color: colorFor(active.category) }}
              >
                {active.category}
              </span>
              <span className="text-2xl font-bold tabular-nums">
                {active.message_count.toLocaleString()}
              </span>
              <span className="text-[11px] uppercase tracking-wide text-muted">
                {Math.round((active.message_count / total) * 100)}% of mail
              </span>
            </>
          ) : (
            <>
              <span className="text-2xl font-bold tabular-nums">
                {total.toLocaleString()}
              </span>
              <span className="text-[11px] uppercase tracking-wide text-muted">
                messages
              </span>
            </>
          )}
        </div>
      </div>
      <p className="mt-2 text-xs text-muted">Hover a segment for details</p>
    </div>
  );
}
