"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Mic, Square } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/Button";
import { useDataBump } from "@/components/DataSync";

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

interface AskOption {
  label: string;
  hint?: string;
  recommended?: boolean;
}

interface Asking {
  question: string;
  options: AskOption[];
}

// Tolerant of the legacy string shape (in-flight pre-change threads) and the
// new {label,hint,recommended} objects the server now emits.
function normalizeAskOptions(raw: unknown): AskOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AskOption[] = [];
  let recommendedSeen = false;
  for (const item of raw) {
    if (typeof item === "string") {
      const label = item.trim();
      if (label) out.push({ label });
    } else if (item && typeof item === "object") {
      const o = item as { label?: unknown; hint?: unknown; recommended?: unknown };
      const label = typeof o.label === "string" ? o.label.trim() : "";
      if (!label) continue;
      const opt: AskOption = { label };
      if (typeof o.hint === "string" && o.hint.trim()) opt.hint = o.hint.trim();
      if (o.recommended === true && !recommendedSeen) {
        opt.recommended = true;
        recommendedSeen = true;
      }
      out.push(opt);
    }
    if (out.length >= 4) break;
  }
  return out;
}

// Assistant replies are markdown but we want them to read at full foreground
// weight (the default `prose` plugin colour is a muted grey). Skip the prose
// plugin entirely — give the wrapper an explicit `text-foreground` and
// re-create just the spacing/typography hints we actually use.
function Markdown({ children }: { children: string }) {
  return (
    <div className="max-w-none break-words text-sm leading-relaxed text-foreground [&_*]:text-foreground [&_a]:underline [&_code]:rounded [&_code]:bg-[var(--brand-soft)] [&_code]:px-1 [&_code]:py-0.5 [&_h1]:mb-1 [&_h1]:mt-3 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:font-semibold [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-[var(--brand-soft)] [&_pre]:p-2 [&_strong]:font-semibold [&_table]:my-2 [&_table]:block [&_table]:overflow-x-auto [&_table]:text-xs [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

// One tidy representation of "a tool ran", shared by the live stream and
// persisted tool-role history so both surfaces look identical.
function ToolPill({ name, running }: { name: string; running: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--brand-soft)] px-2.5 py-0.5 text-xs font-medium text-[var(--brand)] transition-opacity">
      <span aria-hidden>{running ? "⏳" : "✓"}</span>
      {name}
    </span>
  );
}

export default function ChatPanel() {
  const [threadId, setThreadId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live (in-flight turn) buffers.
  const [liveText, setLiveText] = useState("");
  const [chips, setChips] = useState<ToolChip[]>([]);

  // Onboarding surfaces.
  const [connectCard, setConnectCard] = useState(false);
  const [pipeline, setPipeline] = useState<{
    phase: string;
    scanned?: number;
    classified?: number;
    totalSenders?: number;
    error?: string;
  } | null>(null);
  const [persona, setPersona] = useState<string | null>(null);
  const [personaEdit, setPersonaEdit] = useState("");
  const personaFetched = useRef(false);
  const [cProvider, setCProvider] = useState<"imap" | "gmail" | "outlook">("imap");
  const [cImap, setCImap] = useState({ host: "", port: "993", user: "", password: "" });
  const [cBusy, setCBusy] = useState(false);

  const bump = useDataBump();

  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pending, busy, liveText, chips]);

  async function loadThreads(): Promise<ThreadInfo[]> {
    try {
      const res = await fetch("/api/mail-analyzer/chat");
      const data = await res.json();
      const list: ThreadInfo[] = data.threads ?? [];
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
        // A still-open ask_user is resurfaced by the server so the option
        // buttons survive a reload / returning-user greeting.
        {
          const opts = normalizeAskOptions(td.asking?.options);
          setAsking(opts.length ? { question: td.asking.question, options: opts } : null);
        }
        setConnectCard(false);
        setPersona(null);
        setPipeline(null);
        personaFetched.current = false;
        setError(null);
      }
    } catch {
      /* ignore */
    }
  }

  // Resume the most recent thread on mount — unless onboarding needs to start.
  useEffect(() => {
    (async () => {
      // Profile → "Rebuild profile" sends ?rebuild=1: force a brand-new
      // onboarding conversation even though older threads exist (otherwise we'd
      // just resume the old chat and onboarding would never visibly start).
      const forceRebuild =
        typeof window !== "undefined" &&
        new URLSearchParams(window.location.search).get("rebuild") === "1";
      if (forceRebuild && typeof window !== "undefined") {
        window.history.replaceState(null, "", "/app");
      }

      const list = await loadThreads();
      let onboarded: boolean | undefined;
      try {
        const s = await fetch("/api/mail-analyzer/onboarding/status").then((r) => r.json());
        onboarded = s?.onboarded;
      } catch {
        /* ignore */
      }

      // Single chat: exactly one thread per user. Resume it if it exists.
      const existing = list[0]?.id ?? null;
      if (existing) await loadThread(existing);

      // Brand-new user → create the one thread by sending the kickoff.
      // Rebuild → continue onboarding in the SAME thread (onboarding is gated
      // by the user_profile memory, not the thread, so no second chat).
      if (onboarded === false && (forceRebuild || !existing)) {
        if (!existing) newChat();
        sendMessage("Hi — let's set up my mailbox.", existing);
        return;
      }

      // Mid-pipeline reload: the scan→classify chain runs server-side in
      // Inngest, but loadThread just cleared any pipeline state. If onboarding
      // is still active and this thread already kicked off run_pipeline,
      // re-seed the pipeline so the live loading card + poll resume — otherwise
      // the user sees a dead transcript and starts chatting at the agent.
      if (onboarded === false && existing) {
        try {
          const td = await fetch(`/api/mail-analyzer/chat?threadId=${existing}`).then((r) =>
            r.json(),
          );
          const started = (td.messages ?? []).some(
            (m: ChatMsg) => m.role === "tool" && m.tool_name === "run_pipeline",
          );
          if (started) {
            const s = await fetch("/api/mail-analyzer/onboarding/pipeline").then((r) => r.json());
            if (s?.phase && s.phase !== "done") {
              personaFetched.current = false;
              setPipeline(s);
            }
          }
        } catch {
          /* ignore — worst case the user re-triggers the pipeline via chat */
        }
      }

      // Returning, already-onboarded user: ask the server what changed since
      // last visit. It only responds with a message when there's news (and has
      // already appended it server-side); otherwise the chat is left untouched.
      if (!forceRebuild && onboarded !== false) {
        try {
          const g = await fetch("/api/mail-analyzer/greeting", { method: "POST" }).then((r) =>
            r.json(),
          );
          if (g?.message && g?.threadId) {
            // The greeting is already persisted; reload that thread so the
            // transcript is exactly what the server has (no state mixing).
            await loadThread(g.threadId);
          }
        } catch {
          /* a missing greeting is never an error worth surfacing */
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll the durable scan→classify→propose pipeline and drive the loading view.
  useEffect(() => {
    if (!pipeline || pipeline.phase === "done" || pipeline.phase === "error") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await fetch("/api/mail-analyzer/onboarding/pipeline").then((r) => r.json());
        if (cancelled || !s || !s.phase) return;
        setPipeline(s);
        if (s.phase === "persona_ready" && !personaFetched.current && !persona) {
          personaFetched.current = true;
          const d = await fetch("/api/mail-analyzer/onboarding/persona-draft", {
            method: "POST",
          }).then((r) => r.json());
          if (!cancelled && d?.persona) {
            setPersona(d.persona);
            setPersonaEdit(d.persona);
          }
        }
        if (s.phase === "done" && threadId != null) {
          await loadThread(threadId);
          bump();
        }
      } catch {
        /* transient — keep polling */
      }
    };
    const id = setInterval(tick, 4000);
    tick();
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipeline?.phase, threadId]);

  function resetLive() {
    setLiveText("");
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
        // `thinking` deltas are consumed but intentionally not rendered —
        // the tool chips are the only agent-activity surface we show.
        else if (ev.type === "thinking") {
          /* discard */
        } else if (ev.type === "tool") {
          setChips((c) => {
            if (ev.phase === "done") {
              // A tool finished — it may have changed mailbox data. Tell the
              // side panes to refresh without a page reload.
              bump();
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
          setAsking({ question: ev.question, options: normalizeAskOptions(ev.options) });
        } else if (ev.type === "connect") {
          setConnectCard(true);
        } else if (ev.type === "pipeline") {
          personaFetched.current = false;
          setPipeline({ phase: "scanning" });
        } else if (ev.type === "done") {
          if (ev.threadId) setThreadId(ev.threadId);
          setMessages(ev.messages ?? []);
          setPending(ev.pending ?? null);
          resetLive();
          loadThreads();
          bump();
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

  function sendMessage(message: string, tid: number | null = threadId) {
    if (!message.trim()) return;
    setMessages((m) => [
      ...m,
      { id: Date.now(), role: "user", content: message, tool_name: null, created_at: "" },
    ]);
    run("/api/mail-analyzer/chat", { threadId: tid, message });
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
      bump();
      // Keep polling: pipeline continues into proposing → done, and the
      // poll's `done` transition reloads the thread.
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
    setPipeline(null);
    personaFetched.current = false;
    setError(null);
    resetLive();
  }

  return (
    <div className="flex h-full flex-col">
      {/* Messages (scrollable) — no header; the app header carries the title.
          Content is a fixed-width centered reading column (not pane-wide). */}
      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto w-full max-w-2xl space-y-4">
        {messages.length === 0 && !busy && (
          <p className="text-sm text-muted">
            e.g. “The folder proposals look off — walk me through them and suggest a cleaner
            taxonomy.”
          </p>
        )}

        {messages.map((m) => {
          if (m.role === "tool") {
            return (
              <div key={m.id}>
                <ToolPill name={m.tool_name ?? "tool"} running={false} />
              </div>
            );
          }
          if (m.role === "user") {
            return (
              <div
                key={m.id}
                className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl bg-[var(--brand-soft)] px-4 py-2 text-sm leading-relaxed text-foreground"
              >
                {m.content}
              </div>
            );
          }
          return (
            <div key={m.id} className="max-w-[92%] text-sm leading-relaxed">
              <Markdown>{m.content ?? ""}</Markdown>
            </div>
          );
        })}

        {/* Live in-flight turn */}
        {busy && (liveText || chips.length > 0) && (
          <div className="space-y-2">
            {chips.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {chips.map((c, i) => (
                  <ToolPill key={i} name={c.name} running={c.phase === "running"} />
                ))}
              </div>
            )}
            {liveText && (
              <div className="max-w-[92%] text-sm leading-relaxed">
                <Markdown>{liveText}</Markdown>
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

        {pipeline && pipeline.phase !== "done" && !persona && (
          <div className="card space-y-2 border border-sky-500/40 p-4 text-sm">
            {pipeline.phase === "error" ? (
              <div className="text-red-600 dark:text-red-400">
                Scan failed: {pipeline.error}. Ask me to try again.
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 font-medium">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-sky-500" />
                  {pipeline.phase === "scanning"
                    ? "Scanning your mailbox…"
                    : pipeline.phase === "classifying"
                      ? "Classifying senders…"
                      : pipeline.phase === "persona_ready"
                        ? "Building your profile…"
                        : "Creating your folder proposals…"}
                </div>
                <div className="text-xs text-muted">
                  {pipeline.phase === "scanning" &&
                    `${(pipeline.scanned ?? 0).toLocaleString()} messages so far`}
                  {pipeline.phase === "classifying" &&
                    `${(pipeline.classified ?? 0).toLocaleString()}${
                      pipeline.totalSenders
                        ? ` / ${pipeline.totalSenders.toLocaleString()}`
                        : ""
                    } senders`}
                  {(pipeline.phase === "persona_ready" ||
                    pipeline.phase === "proposing") &&
                    "This can take a few minutes on a large mailbox — you can keep this open."}
                </div>
              </>
            )}
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
                      : "border-input text-muted"
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
              <p className="text-sm text-muted">
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
          <div className="space-y-2">
            {asking.options.map((opt, i) => (
              <button
                key={i}
                onClick={() => sendMessage(opt.label)}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-left transition hover:border-[var(--brand)] hover:bg-[var(--brand-soft)]"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{opt.label}</span>
                  {opt.recommended && (
                    <span className="rounded-full bg-[var(--brand-soft)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--brand)]">
                      Recommended
                    </span>
                  )}
                </div>
                {opt.hint && (
                  <div className="mt-0.5 text-xs text-muted">{opt.hint}</div>
                )}
              </button>
            ))}
            <p className="text-xs text-muted">…or type your own answer below.</p>
          </div>
        )}

        {busy && !liveText && chips.length === 0 && (
          <div className="text-sm text-muted">Agent is thinking…</div>
        )}
        <div ref={endRef} />
        </div>
      </div>

      {error && (
        <div className="card mx-4 border border-red-500/40 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Composer — same fixed-width centered island as the message column */}
      <div className="px-4 pb-4 pt-3">
        <div className="mx-auto w-full max-w-2xl">
        <div className="flex items-end gap-2 rounded-2xl border border-input bg-background px-3 py-2 focus-within:ring-2 focus-within:ring-[var(--brand)]">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask or instruct…"
            disabled={busy}
            rows={3}
            className="max-h-48 min-h-[76px] flex-1 resize-none bg-transparent py-1 text-sm focus:outline-none disabled:opacity-60"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          {/* Voice input — placeholder for future Whisper support */}
          <button
            type="button"
            disabled
            aria-label="Voice input (coming soon)"
            title="Voice input (coming soon)"
            className="rounded-full p-2 text-muted opacity-50"
          >
            <Mic size={18} />
          </button>
          {busy ? (
            <button
              type="button"
              onClick={stop}
              aria-label="Stop"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--brand)] text-white transition hover:bg-[var(--brand-hover)]"
            >
              <Square size={15} />
            </button>
          ) : (
            <button
              type="button"
              onClick={send}
              disabled={!input.trim()}
              aria-label="Send"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--brand)] text-white transition hover:bg-[var(--brand-hover)] disabled:opacity-40"
            >
              <ArrowUp size={18} />
            </button>
          )}
        </div>
        <p className="mt-1.5 px-1 text-xs text-muted">
          Enter to send · Shift + Enter for a new line
        </p>
        </div>
      </div>
    </div>
  );
}
