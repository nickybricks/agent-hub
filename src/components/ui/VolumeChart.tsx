"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

interface VolumeRow {
  day: string;
  message_count: number;
}

export function VolumeChart({ data }: { data: VolumeRow[] }) {
  if (data.length === 0) {
    return <p className="text-muted text-sm">No data.</p>;
  }

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="day"
            tick={{ fill: "var(--muted)", fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
            interval={Math.max(0, Math.floor(data.length / 10))}
            tickFormatter={(d: string) => d.slice(5)}
          />
          <YAxis
            tick={{ fill: "var(--muted)", fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
            width={40}
          />
          <Tooltip
            cursor={{ fill: "var(--accent-soft)" }}
            contentStyle={{
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: "0.625rem",
              fontSize: 12,
              color: "var(--foreground)",
              boxShadow: "var(--card-shadow)",
            }}
            labelStyle={{ color: "var(--muted)", marginBottom: 4 }}
            formatter={(v) => [Number(v).toLocaleString(), "messages"]}
          />
          <Bar dataKey="message_count" fill="var(--accent)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
