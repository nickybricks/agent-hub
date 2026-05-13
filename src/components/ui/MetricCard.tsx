"use client";

import { ReactNode } from "react";
import { motion } from "framer-motion";

interface MetricCardProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  trend?: ReactNode;
  index?: number;
}

export function MetricCard({ label, value, hint, trend, index = 0 }: MetricCardProps) {
  return (
    <motion.div
      className="card p-6 flex flex-col gap-2"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", bounce: 0.2, duration: 0.4, delay: index * 0.06 }}
    >
      <p
        className="text-[11px] font-semibold uppercase tracking-[0.14em]"
        style={{ color: "var(--muted)" }}
      >
        {label}
      </p>
      <p
        className="text-3xl font-bold tracking-tight tabular-nums"
        style={{ color: "var(--foreground)", fontVariantNumeric: "tabular-nums" }}
      >
        {value}
      </p>
      {hint && <p className="text-xs" style={{ color: "var(--muted)" }}>{hint}</p>}
      {trend && <div className="pt-1">{trend}</div>}
    </motion.div>
  );
}
