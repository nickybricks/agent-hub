"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";

interface ChatMsg {
  id: number;
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_name: string | null;
  created_at: string;
}

interface Pending {
  id: number;
  tool_name: string;
  input: Record<string, unknown>;
  summary: string;
}

interface ToolChip {
  name: string;
  phase: "running" | "done";
}

interface ThreadInfo {
  id: number;
  title: string | null;
  updated_at: string;
}

interface Asking {
  question: string;
  options: string[];
}

export default function ChatPanel() {
  const [threadId, setThreadId] = useState<number | null>(null);
  const [threads, setThreads] = useState<ThreadInfo[]>([]);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live (in-flight turn) buffers.
  const [liveText, setLiveText] = useState("");
  const [liveThinking, setLiveThinking] = useState("");
  const [showThinking, setShowThinking] = useState(false);
  const [chips, setChips] = useState<ToolChip[]>([]);

  // Onboarding surfaces.
  const [connectCard, setConnectCard] = useState(false);
  const [progress, setProgress] = useState<string[]>([]);
  const [persona, setPersona] = useState<string | null>(null);
  const [personaEdit, setPersonaEdit] = useState("");
  const [cProvider, setCProvider] = useState<"imap" | "gmail" | "outlook">("imap");
  const [cImap, setCImap] = useState({ host: "", port: "993", user: "", password: "" });
  const [cBusy, setCBusy] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pending, busy, liveText, liveThinking, chips]);

  async function loadThreads(): Promise<ThreadInfo[]> {
    try {
      const res = await fetch("/api/mail-analyzer/chat");
      const data = await res.json();
      const list: ThreadInfo[] = data.threads ?? [];
      setThreads(list);
      return list;
    } catch {
      return [];
    }
  }

  async function loadThread(id: number) {
    try {
      const t = await fetch(`/api/mail-analyzer/chat?threadId=${id}`);
      const td = await t.json();
      if (t.ok) {
        setThreadId(id);
        setMessages(td.messages ?? []);
        setPending(td.pending ?? null);
        setAsking(null);
        setConnectCard(false);
        setPersona(null);
        setProgress([]);
        setError(null);
      }
    } catch {
      /* ignore */
    }
  }

  // Resume the most recent thread on mount.
  useEffect(() => {
    (async () => {
      const list = await loadThreads();
      if (list[0]) {
        await loadThread(list[0].id);
        return;
      }
      // Brand-new user with no chats yet: if onboarding is incomplete, open the
      // onboarding conversation automatically.
      try {
        const s = await fetch("/api/mail-analyzer/onboarding/status").then((r) => r.json());
        if (s && s.onboarded === false) sendMessage("Hi — let's set up my mailbox.");
      } catch {
        /* ignore */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetLive() {
    setLiveText("");
    setLiveThinking("");
    setChips([]);
  }

  async function consume(res: Response) {
    if (!res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame.trim();
        if (!line.startsWith("data:")) continue;
        const ev = JSON.parse(line.slice(5).trim());
        if (ev.type === "token") setLiveText((s) => s + ev.delta);
        else if (ev.type === "thinking") {
          setLiveThinking((s) => s + ev.delta);
          setShowThinking(true);
        } else if (ev.type === "tool") {
          setChips((c) => {
            if (ev.phase === "done") {
              const i = [...c].reverse().findIndex((x) => x.name === ev.name && x.phase === "running");
              if (i >= 0) {
                const idx = c.length - 1 - i;
                const next = [...c];
                next[idx] = { name: ev.name, phase: "done" };
                return next;
              }
            }
            return [...c, { name: ev.name, phase: ev.phase }];
          });
        } else if (ev.type === "pending") {
          setPending(ev.pending);
        } else if (ev.type === "ask") {
          setAsking({ question: ev.question, options: ev.options ?? [] });
        } else if (ev.type === "connect") {
          setConnectCard(true);
        } else if (ev.type === "progress") {
          setProgress((p) => [...p, ev.label]);
        } else if (ev.type === "persona") {
          setPersona(ev.text);
          setPersonaEdit(ev.text);
        } else if (ev.type === "done") {
          if (ev.threadId) setThreadId(ev.threadId);
          setMessages(ev.messages ?? []);
          setPending(ev.pending ?? null);
          resetLive();
          loadThreads();
        } else if (ev.type === "error") {
          setError(ev.message);
        }
      }
    }
  }

  async function run(url: string, body: unknown) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setAsking(null);
    setProgress([]);
    resetLive();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (res.headers.get("content-type")?.includes("application/json")) {
        const data = await res.json();
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      await consume(res);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function sendMessage(message: string) {
    if (!message.trim()) return;
    setMessages((m) => [
      ...m,
      { id: Date.now(), role: "user", content: message, tool_name: null, created_at: "" },
    ]);
    run("/api/mail-analyzer/chat", { threadId, message });
  }

  function send() {
    const message = input.trim();
    if (!message) return;
    setInput("");
    sendMessage(message);
  }

  function decide(decision: "apply" | "cancel") {
    if (!pending) return;
    const id = pending.id;
    setPending(null);
    run("/api/mail-analyzer/chat/confirm", { toolCallId: id, decision });
  }

  async function submitConnect() {
    setCBusy(true);
    setError(null);
    try {
      if (cProvider === "gmail" || cProvider === "outlook") {
        window.location.href = `/api/auth/${cProvider === "gmail" ? "google" : "microsoft"}/start`;
        return;
      }
      const res = await fetch("/api/settings/mail", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "imap",
          imap: { ...cImap, port: Number(cImap.port) || 993 },
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      setConnectCard(false);
      sendMessage("I've connected my mailbox — let's continue.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCBusy(false);
    }
  }

  async function savePersona() {
    if (!persona || threadId == null) return;
    setCBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/mail-analyzer/onboarding/persona", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId, persona: personaEdit }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      setPersona(null);
      setProgress([]);
      await loadThread(threadId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCBusy(false);
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function newChat() {
    if (busy) return;
    setThreadId(null);
    setMessages([]);
    setPending(null);
    setAsking(null);
    setConnectCard(false);
    setPersona(null);
    setProgress([]);
    setError(null);
    resetLive();
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold tracking-tight">Mailbox chat</h2>
          <p className="truncate text-xs text-muted-foreground">
            Ask about your mailbox or instruct the agent — it asks before every change.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {threads.length > 0 && (
            <select
              value={threadId ?? ""}
              disabled={busy}
              onChange={(e) => {
                const v = e.target.value;
                if (v) loadThread(Number(v));
              }}
              className="max-w-[160px] rounded-md border border-input bg-background px-2 py-1.5 text-xs disabled:opacity-60"
              aria-label="Past chats"
            >
              {threadId == null && <option value="">New chat…</option>}
              {threads.map((t) => (
                <option key={t.id} value={t.id}>
                  {(t.title || `Chat #${t.id}`).slice(0, 40)}
                </option>
              ))}
            </select>
          )}
          <Button variant="ghost" size="sm" onClick={newChat} disabled={busy}>
            New chat
          </Button>
        </div>
      </header>

      {/* Messages (scrollable) */}
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && !busy && (
          <div className="card p-4 text-sm text-muted-foreground">
            e.g. “The folder proposals look off — walk me through them and suggest a cleaner
            taxonomy.”
          </div>
        )}

        {messages.map((m) => {
          if (m.role === "tool") {
            return (
              <div
                key={m.id}
                className="border-l-2 border-border pl-3 font-mono text-xs text-muted-foreground"
              >
                🔧 {m.tool_name}: {(m.content ?? "").slice(0, 300)}
              </div>
            );
          }
          const mine = m.role === "user";
          return (
            <div
              key={m.id}
              className={`card whitespace-pre-wrap p-3 text-sm leading-relaxed ${
                mine ? "ml-8 bg-accent/40" : "mr-8"
              }`}
            >
              <div className="mb-1 text-xs text-muted-foreground">{mine ? "You" : "Agent"}</div>
              {m.content}
            </div>
          );
        })}

        {/* Live in-flight turn */}
        {busy && (liveThinking || liveText || chips.length > 0) && (
          <div className="mr-8 space-y-2">
            {liveThinking && (
              <div className="card p-3 text-xs">
                <button
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setShowThinking((v) => !v)}
                >
                  {showThinking ? "▾" : "▸"} Thinking
                </button>
                {showThinking && (
                  <div className="mt-2 whitespace-pre-wrap italic text-muted-foreground">
                    {liveThinking}
                  </div>
                )}
              </div>
            )}
            {chips.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {chips.map((c, i) => (
                  <span
                    key={i}
                    className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                  >
                    {c.phase === "running" ? "⏳" : "✓"} {c.name}
                  </span>
                ))}
              </div>
            )}
            {liveText && (
              <div className="card whitespace-pre-wrap p-3 text-sm leading-relaxed">
                <div className="mb-1 text-xs text-muted-foreground">Agent</div>
                {liveText}
              </div>
            )}
          </div>
        )}

        {pending && (
          <div className="card space-y-3 border border-amber-500/50 p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
              Confirmation required · {pending.tool_name}
            </div>
            <div className="text-sm">{pending.summary}</div>
            <pre className="overflow-x-auto rounded bg-muted/50 p-2 text-xs">
              {JSON.stringify(pending.input, null, 2)}
            </pre>
            <div className="flex gap-2">
              <Button onClick={() => decide("apply")} disabled={busy}>
                Apply
              </Button>
              <Button variant="ghost" onClick={() => decide("cancel")} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {progress.length > 0 && (
          <div className="card space-y-1 p-3 text-sm">
            {progress.map((p, i) => (
              <div
                key={i}
                className={i === progress.length - 1 ? "" : "text-muted-foreground"}
              >
                {i === progress.length - 1 && busy ? "⏳ " : "✓ "}
                {p}
              </div>
            ))}
          </div>
        )}

        {connectCard && (
          <div className="card space-y-3 border border-sky-500/50 p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-sky-600 dark:text-sky-400">
              Connect your mailbox
            </div>
            <div className="flex gap-2 text-sm">
              {(["imap", "gmail", "outlook"] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setCProvider(p)}
                  className={`rounded-md border px-2 py-1 text-xs ${
                    cProvider === p
                      ? "border-sky-500 bg-sky-500/10"
                      : "border-input text-muted-foreground"
                  }`}
                >
                  {p === "imap" ? "IMAP" : p === "gmail" ? "Gmail" : "Outlook"}
                </button>
              ))}
            </div>
            {cProvider === "imap" ? (
              <div className="space-y-2">
                {(
                  [
                    ["host", "IMAP host (e.g. imap.example.com)"],
                    ["user", "Email / username"],
                    ["password", "Password"],
                    ["port", "Port"],
                  ] as const
                ).map(([k, ph]) => (
                  <input
                    key={k}
                    type={k === "password" ? "password" : "text"}
                    placeholder={ph}
                    value={cImap[k]}
                    onChange={(e) => setCImap((s) => ({ ...s, [k]: e.target.value }))}
                    className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                You&apos;ll be redirected to sign in with{" "}
                {cProvider === "gmail" ? "Google" : "Microsoft"} and brought back here.
              </p>
            )}
            <Button onClick={submitConnect} disabled={cBusy}>
              {cBusy ? "Connecting…" : "Connect"}
            </Button>
          </div>
        )}

        {persona && (
          <div className="card space-y-3 border border-emerald-500/50 p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
              Here&apos;s what I learned about you — edit anything that&apos;s off
            </div>
            <textarea
              value={personaEdit}
              onChange={(e) => setPersonaEdit(e.target.value)}
              className="min-h-[140px] w-full rounded-md border border-input bg-background p-2 text-sm leading-relaxed"
            />
            <div className="flex gap-2">
              <Button onClick={savePersona} disabled={cBusy || !personaEdit.trim()}>
                {cBusy ? "Saving…" : "Looks good — save"}
              </Button>
            </div>
          </div>
        )}

        {asking && !busy && asking.options.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {asking.options.map((opt, i) => (
              <Button key={i} variant="ghost" onClick={() => sendMessage(opt)}>
                {opt}
              </Button>
            ))}
            <span className="self-center text-xs text-muted-foreground">
              …or type your own answer below
            </span>
          </div>
        )}

        {busy && !liveText && !liveThinking && chips.length === 0 && (
          <div className="text-sm text-muted-foreground">Agent is thinking…</div>
        )}
        <div ref={endRef} />
      </div>

      {error && (
        <div className="card mx-4 border border-red-500/40 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Composer */}
      <div className="border-t border-border p-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask or instruct…"
          disabled={busy}
          className="min-h-[64px] w-full rounded-md border border-input bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
          }}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">⌘/Ctrl + Enter to send</span>
          {busy ? (
            <Button variant="ghost" onClick={stop}>
              Stop
            </Button>
          ) : (
            <Button onClick={send} disabled={!input.trim()}>
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
