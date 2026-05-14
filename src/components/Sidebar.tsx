"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard,
  Mail,
  BookOpen,
  Settings,
  Sparkles,
  Menu,
  X,
  Stethoscope,
  FolderTree,
} from "lucide-react";
import ThemeToggle from "./ThemeToggle";

type NavItem = {
  href: string;
  label: string;
  icon: React.ElementType;
  statusKey?: "mail-analyzer";
};
type NavSection = { label: string; items: NavItem[] };

const sections: NavSection[] = [
  {
    label: "Overview",
    items: [{ href: "/", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Mail",
    items: [
      { href: "/mail-analyzer", label: "Mail Analyzer", icon: Mail, statusKey: "mail-analyzer" },
      { href: "/mail-analyzer/audit", label: "Mailbox Audit", icon: Stethoscope },
      { href: "/mail-analyzer/proposals", label: "Folder Proposals", icon: FolderTree },
      { href: "/agents/newsletter-summarizer", label: "Newsletter Agent", icon: BookOpen },
    ],
  },
  {
    label: "Settings",
    items: [{ href: "/settings/mail", label: "Mail Settings", icon: Settings }],
  },
];

type AnalyzerStatus = "ok" | "stale" | "running" | "error" | null;

function useAnalyzerStatus(): AnalyzerStatus {
  const [status, setStatus] = useState<AnalyzerStatus>(null);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      try {
        const ov = await fetch("/api/mail-analyzer/overview").then((r) => r.json());
        if (cancelled) return;
        const last = ov?.lastRun;
        if (!last) return setStatus(null);
        if (last.status === "running") return setStatus("running");
        if (last.status !== "ok") return setStatus("error");
        const ageMs = Date.now() - (last.finished_at ? new Date(last.finished_at).getTime() : 0);
        setStatus(ageMs > 60 * 60 * 1000 ? "stale" : "ok");
      } catch {
        if (!cancelled) setStatus(null);
      }
    }

    tick();
    const t = setInterval(tick, 10_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return status;
}

function StatusDot({ status }: { status: AnalyzerStatus }) {
  if (!status) return null;
  const cls = {
    ok:      "bg-[var(--success)]",
    stale:   "bg-[var(--warning)]",
    running: "bg-[var(--accent)] animate-pulse",
    error:   "bg-[var(--danger)]",
  } as const;
  return (
    <span
      className={`ml-auto h-2 w-2 shrink-0 rounded-full ${cls[status]}`}
      aria-label={`status: ${status}`}
    />
  );
}

function NavLink({ item, active, analyzerStatus }: { item: NavItem; active: boolean; analyzerStatus: AnalyzerStatus }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className="relative flex h-10 items-center gap-3 rounded-[0.625rem] px-3 text-sm font-medium"
      style={{ color: active ? "var(--brand)" : "var(--muted)" }}
    >
      {active && (
        <motion.span
          layoutId="nav-active"
          className="absolute inset-0 rounded-[0.625rem]"
          style={{ background: "var(--brand-soft)" }}
          transition={{ type: "spring", bounce: 0.2, duration: 0.35 }}
        />
      )}
      <Icon
        size={16}
        className="relative shrink-0 transition-opacity"
        style={{ opacity: active ? 1 : 0.6 }}
      />
      <span className="relative flex-1 truncate">{item.label}</span>
      {item.statusKey === "mail-analyzer" && (
        <span className="relative">
          <StatusDot status={analyzerStatus} />
        </span>
      )}
    </Link>
  );
}

function SidebarContent({ pathname, analyzerStatus }: { pathname: string; analyzerStatus: AnalyzerStatus }) {
  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(href + "/");
  }

  return (
    <>
      {/* Logo */}
      <Link href="/" className="flex items-center gap-3 px-3 py-2 mb-2">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[0.75rem] shadow-lg"
          style={{
            background: "linear-gradient(135deg, var(--brand), var(--accent-blue))",
            boxShadow: "0 4px 12px color-mix(in oklch, var(--brand) 30%, transparent)",
          }}
        >
          <Sparkles size={16} className="text-white" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-bold tracking-tight" style={{ color: "var(--foreground)" }}>
            Mail Workflow
          </p>
          <p className="text-[11px]" style={{ color: "var(--muted)" }}>
            Inbox intelligence
          </p>
        </div>
      </Link>

      {/* Nav sections */}
      <nav className="flex-1 overflow-y-auto space-y-1 px-2">
        {sections.map((section, i) => (
          <div key={section.label} className={i === 0 ? "pb-1" : "pt-4 pb-1"}>
            <p
              className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-[0.14em]"
              style={{ color: "var(--sidebar-section-label)" }}
            >
              {section.label}
            </p>
            <ul className="space-y-0.5">
              {section.items.map((item) => (
                <li key={item.href}>
                  <NavLink item={item} active={isActive(item.href)} analyzerStatus={analyzerStatus} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div
        className="mx-2 mt-4 flex items-center justify-between rounded-[0.625rem] px-3 py-2 border-t"
        style={{ borderColor: "var(--border)" }}
      >
        <span className="text-xs" style={{ color: "var(--muted)" }}>Theme</span>
        <ThemeToggle />
      </div>
    </>
  );
}

export default function Sidebar() {
  const pathname = usePathname();
  const analyzerStatus = useAnalyzerStatus();

  return (
    <aside className="sidebar-surface fixed left-4 top-4 bottom-4 z-20 hidden w-[256px] flex-col py-5 px-2 md:flex">
      <SidebarContent pathname={pathname} analyzerStatus={analyzerStatus} />
    </aside>
  );
}

/* Mobile top bar */
export function MobileTopBar() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const analyzerStatus = useAnalyzerStatus();

  useEffect(() => { setOpen(false); }, [pathname]);

  return (
    <>
      <header className="sidebar-surface sticky top-3 z-20 mx-3 flex items-center justify-between px-4 py-3 md:hidden">
        <Link href="/" className="flex items-center gap-2">
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[0.625rem]"
            style={{ background: "linear-gradient(135deg, var(--brand), var(--accent-blue))" }}
          >
            <Sparkles size={14} className="text-white" />
          </div>
          <span className="text-sm font-bold tracking-tight" style={{ color: "var(--foreground)" }}>
            Mail Workflow
          </span>
        </Link>
        <button
          onClick={() => setOpen((v) => !v)}
          className="rounded-lg p-1.5 transition-colors hover:bg-[var(--card-hover)]"
          aria-label="Toggle menu"
        >
          {open ? <X size={18} /> : <Menu size={18} />}
        </button>
      </header>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              className="fixed inset-0 z-10 md:hidden"
              style={{ background: "oklch(0 0 0 / 30%)" }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
            />
            <motion.div
              className="sidebar-surface fixed left-4 top-[4.5rem] bottom-4 z-20 w-[256px] flex flex-col py-5 px-2 md:hidden"
              initial={{ opacity: 0, x: -16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ type: "spring", bounce: 0.1, duration: 0.3 }}
            >
              <SidebarContent pathname={pathname} analyzerStatus={analyzerStatus} />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
