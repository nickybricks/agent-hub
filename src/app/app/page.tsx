"use client";

import { useState } from "react";
import ChatPanel from "@/components/ChatPanel";
import HomePane from "@/components/panes/HomePane";
import ProposalsTab from "@/app/mail-analyzer/proposals/page";
import AuditTab from "@/app/mail-analyzer/audit/page";
import HistoryTab from "@/app/mail-analyzer/history/page";

const TABS = ["Home", "Proposals", "Audit", "Profile", "History"] as const;
type Tab = (typeof TABS)[number];

export default function AppShell() {
  const [tab, setTab] = useState<Tab>("Home");

  return (
    <div className="flex h-screen flex-col md:flex-row">
      {/* Left: dashboard tabs */}
      <section className="flex min-w-0 flex-1 flex-col">
        <nav className="flex shrink-0 gap-1 border-b border-border px-4 py-2">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
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
          {tab === "Home" && <HomePane onNavigate={(t) => setTab(t as Tab)} />}
          {tab === "Proposals" && <ProposalsTab />}
          {tab === "Audit" && <AuditTab />}
          {tab === "History" && <HistoryTab />}
          {tab === "Profile" && (
            <div className="mx-auto max-w-2xl px-8 py-10">
              <h1 className="mb-1 text-2xl font-semibold tracking-tight">Profile</h1>
              <p className="text-sm text-muted">
                Persona, questionnaire answers, and memories will live here. Coming with the
                onboarding chat flow.
              </p>
            </div>
          )}
        </div>
      </section>

      {/* Right: persistent chat */}
      <aside className="flex h-[60vh] shrink-0 flex-col border-t border-border md:h-auto md:w-[420px] md:border-l md:border-t-0 lg:w-[480px]">
        <ChatPanel />
      </aside>
    </div>
  );
}
