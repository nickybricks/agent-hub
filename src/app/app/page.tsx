"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import ChatPanel from "@/components/ChatPanel";
import HomePane from "@/components/panes/HomePane";
import ProposalsPane from "@/components/panes/ProposalsPane";
import AuditPane from "@/components/panes/AuditPane";
import HistoryPane from "@/components/panes/HistoryPane";
import ProfilePane from "@/components/panes/ProfilePane";

const TABS = ["Home", "Proposals", "Audit", "Profile", "History"] as const;
type Tab = (typeof TABS)[number];

export default function AppShell() {
  const [tab, setTab] = useState<Tab>("Home");
  // Keep-alive: a tab's pane is mounted the first time it's opened and stays
  // mounted (hidden when inactive) so switching back is instant — no refetch.
  const [mounted, setMounted] = useState<Set<Tab>>(() => new Set<Tab>(["Home"]));

  const select = (t: Tab) => {
    setMounted((m) => (m.has(t) ? m : new Set(m).add(t)));
    setTab(t);
  };

  const pane: Record<Tab, ReactNode> = {
    Home: <HomePane onNavigate={(t) => select(t as Tab)} />,
    Proposals: <ProposalsPane />,
    Audit: <AuditPane />,
    Profile: <ProfilePane />,
    History: <HistoryPane />,
  };

  return (
    <div className="flex h-screen flex-col md:flex-row">
      {/* Left: dashboard tabs */}
      <section className="flex min-w-0 flex-1 flex-col">
        <nav className="flex shrink-0 gap-1 border-b border-border px-4 py-2">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => select(t)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === t
                  ? "bg-[var(--brand-soft)] text-[var(--brand)]"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {t}
            </button>
          ))}
        </nav>
        <div className="flex-1 overflow-y-auto">
          {TABS.filter((t) => mounted.has(t)).map((t) => (
            <div key={t} className={tab === t ? "" : "hidden"}>
              {pane[t]}
            </div>
          ))}
        </div>
      </section>

      {/* Right: persistent chat */}
      <aside className="flex h-[60vh] shrink-0 flex-col border-t border-border md:h-auto md:w-[420px] md:border-l md:border-t-0 lg:w-[480px]">
        <ChatPanel />
      </aside>
    </div>
  );
}
