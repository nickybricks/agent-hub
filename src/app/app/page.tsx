"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Settings, User } from "lucide-react";
import ChatPanel from "@/components/ChatPanel";
import SettingsModal from "@/components/SettingsModal";
import { DataSyncProvider, useProposingCount } from "@/components/DataSync";
import HomePane from "@/components/panes/HomePane";
import ProposalsPane from "@/components/panes/ProposalsPane";
import AuditPane from "@/components/panes/AuditPane";
import HistoryPane from "@/components/panes/HistoryPane";
import ProfilePane from "@/components/panes/ProfilePane";

const TABS = ["Home", "Proposals", "Audit", "Profile", "History"] as const;
type Tab = (typeof TABS)[number];

const CHAT_KEY = "mi:chatWidth";
const MIN_SIDE = 600; // each side keeps at least this many px
const DEFAULT_CHAT = 480;

export default function AppShell() {
  const [tab, setTab] = useState<Tab>("Home");
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Keep-alive: a tab's pane is mounted the first time it's opened and stays
  // mounted (hidden when inactive) so switching back is instant — no refetch.
  const [mounted, setMounted] = useState<Set<Tab>>(() => new Set<Tab>(["Home"]));

  // Resizable split (chat is on the right). Persisted across sessions.
  const [chatW, setChatW] = useState(DEFAULT_CHAT);
  const chatWRef = useRef(chatW);
  useEffect(() => {
    chatWRef.current = chatW;
  }, [chatW]);
  const rowRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    // Restore persisted width on mount. Done in an effect (not lazy init) to
    // avoid an SSR/client hydration mismatch on the inline width style.
    const saved = Number(localStorage.getItem(CHAT_KEY));
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved && !Number.isNaN(saved)) setChatW(saved);
  }, []);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragging.current || !rowRef.current) return;
      const rect = rowRef.current.getBoundingClientRect();
      const raw = rect.right - e.clientX; // distance from right edge = chat width
      const max = Math.max(MIN_SIDE, rect.width - MIN_SIDE);
      setChatW(Math.min(Math.max(raw, MIN_SIDE), max));
    }
    function onUp() {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.userSelect = "";
      localStorage.setItem(CHAT_KEY, String(Math.round(chatWRef.current)));
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const select = (t: Tab) => {
    setMounted((m) => (m.has(t) ? m : new Set(m).add(t)));
    setTab(t);
  };

  const pane: Record<Tab, ReactNode> = {
    Home: <HomePane active={tab === "Home"} onNavigate={(t) => select(t as Tab)} />,
    Proposals: <ProposalsPane active={tab === "Proposals"} />,
    Audit: <AuditPane active={tab === "Audit"} />,
    Profile: <ProfilePane active={tab === "Profile"} />,
    History: <HistoryPane active={tab === "History"} />,
  };

  return (
    <DataSyncProvider>
      <div className="flex h-screen flex-col">
        {/* App header */}
        <header className="grid shrink-0 grid-cols-3 items-center border-b border-border px-4 py-3">
          <div />
          <div className="text-center text-sm font-semibold tracking-tight">
            <span className="text-[var(--brand)]">Mi</span>{" "}
            <span className="text-muted">— Mail Intelligence</span>
          </div>
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              aria-label="Profile"
              title="Profile"
              onClick={() => setSettingsOpen(true)}
              className="rounded-md p-2 text-muted transition-colors hover:bg-[var(--brand-soft)] hover:text-foreground"
            >
              <User size={18} />
            </button>
            <button
              type="button"
              aria-label="Settings"
              title="Settings"
              onClick={() => setSettingsOpen(true)}
              className="rounded-md p-2 text-muted transition-colors hover:bg-[var(--brand-soft)] hover:text-foreground"
            >
              <Settings size={18} />
            </button>
          </div>
        </header>

        {/* Two-pane resizable body */}
        <div ref={rowRef} className="flex min-h-0 flex-1">
          {/* Left: dashboard */}
          <section className="flex min-w-0 flex-1 flex-col">
            <TabNav tab={tab} onSelect={select} />
            <div className="flex-1 overflow-y-auto">
              {TABS.filter((t) => mounted.has(t)).map((t) => (
                <div key={t} className={tab === t ? "" : "hidden"}>
                  {pane[t]}
                </div>
              ))}
            </div>
          </section>

          {/* Draggable divider */}
          <div
            role="separator"
            aria-orientation="vertical"
            onMouseDown={() => {
              dragging.current = true;
              document.body.style.userSelect = "none";
            }}
            className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-[var(--brand)]"
          />

          {/* Right: persistent chat */}
          <aside
            style={{ width: chatW }}
            className="flex shrink-0 flex-col bg-[var(--background-secondary)]"
          >
            <ChatPanel />
          </aside>
        </div>
      </div>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </DataSyncProvider>
  );
}

function TabNav({ tab, onSelect }: { tab: Tab; onSelect: (t: Tab) => void }) {
  const proposingCount = useProposingCount();
  return (
    <nav className="shrink-0 overflow-x-auto border-b border-border py-3 [-ms-overflow-style:none] [scrollbar-width:none]">
      <div className="mx-auto flex w-full max-w-5xl gap-2 px-8">
        {TABS.map((t) => {
          const showBadge = t === "Proposals" && proposingCount !== null;
          return (
            <button
              key={t}
              onClick={() => onSelect(t)}
              className={`shrink-0 whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                tab === t
                  ? "bg-[var(--brand)] text-white"
                  : "border border-border text-muted hover:text-foreground"
              }`}
            >
              {t}
              {showBadge && (
                <span
                  className={`ml-1.5 inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-semibold ${
                    tab === t
                      ? "bg-white/25 text-white"
                      : "bg-[var(--brand-soft)] text-[var(--brand)]"
                  }`}
                  title={`${proposingCount} folder${proposingCount === 1 ? "" : "s"} ready — still streaming`}
                >
                  {proposingCount}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
