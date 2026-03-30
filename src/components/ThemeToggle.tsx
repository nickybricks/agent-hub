"use client";

import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const stored = localStorage.getItem("theme") as Theme | null;
    if (stored) {
      setTheme(stored);
      applyTheme(stored);
    }
  }, []);

  function applyTheme(t: Theme) {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    if (t === "light") root.classList.add("light");
    else if (t === "dark") root.classList.add("dark");
    // "system" = no class, CSS media query takes over
  }

  function cycle() {
    const order: Theme[] = ["system", "light", "dark"];
    const next = order[(order.indexOf(theme) + 1) % order.length];
    setTheme(next);
    applyTheme(next);
    localStorage.setItem("theme", next);
  }

  // Resolve what the effective appearance is
  function getEffective(): "light" | "dark" {
    if (theme === "light") return "light";
    if (theme === "dark") return "dark";
    if (typeof window !== "undefined") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    return "light";
  }

  if (!mounted) {
    return <div className="w-20 h-8" />; // placeholder to avoid layout shift
  }

  const effective = getEffective();
  const icon = effective === "dark" ? "🌙" : "☀️";
  const label =
    theme === "system" ? "Auto" : theme === "light" ? "Light" : "Dark";

  return (
    <button
      onClick={cycle}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-background-secondary border border-border hover:border-accent/40 transition-all text-sm"
      title={`Theme: ${label} (click to cycle)`}
    >
      <span className="text-base leading-none">{icon}</span>
      <span className="text-xs font-medium text-muted">{label}</span>
    </button>
  );
}
