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

interface ChatResponse {
  threadId?: number;
  thread?: { id: number };
  messages: ChatMsg[];
  pending: Pending | null;
  error?: string;
}

export default function ChatPage() {
  const [threadId, setThreadId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pending, busy]);

  // Resume the most recent thread on mount.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/mail-analyzer/chat");
        const data = await res.json();
        const latest = data.threads?.[0];
        if (latest) {
          const t = await fetch(`/api/mail-analyzer/chat?threadId=${latest.id}`);
          const td: ChatResponse = await t.json();
          if (t.ok) {
            setThreadId(latest.id);
            setMessages(td.messages ?? []);
            setPending(td.pending ?? null);
          }
        }
      } catch {
        /* fresh start is fine */
      }
    })();
  }, []);

  function apply(data: ChatResponse) {
    if (data.error) {
      setError(data.error);
      return;
    }
    if (data.threadId) setThreadId(data.threadId);
    setMessages(data.messages ?? []);
    setPending(data.pending ?? null);
  }

  async function send() {
    const message = input.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    setInput("");
    try {
      const res = await fetch("/api/mail-analyzer/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId, message }),
      });
      apply(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: "apply" | "cancel") {
    if (!pending || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/mail-analyzer/chat/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolCallId: pending.id, decision }),
      });
      apply(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function newChat() {
    setThreadId(null);
    setMessages([]);
    setPending(null);
    setError(null);
  }

  return (
    <div className="mx-auto max-w-3xl p-6 space-y-4">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Mailbox chat</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Ask about your mailbox or tell the agent to act on it. It explains its reasoning and
            asks before every change.
          </p>
        </div>
        <Button variant="ghost" onClick={newChat} disabled={busy}>
          New chat
        </Button>
      </header>

      <div className="space-y-3">
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
                className="text-xs font-mono text-muted-foreground border-l-2 border-border pl-3"
              >
                🔧 {m.tool_name}: {(m.content ?? "").slice(0, 300)}
              </div>
            );
          }
          const mine = m.role === "user";
          return (
            <div
              key={m.id}
              className={`card p-3 text-sm whitespace-pre-wrap leading-relaxed ${
                mine ? "bg-accent/40 ml-8" : "mr-8"
              }`}
            >
              <div className="text-xs text-muted-foreground mb-1">
                {mine ? "You" : "Agent"}
              </div>
              {m.content}
            </div>
          );
        })}

        {pending && (
          <div className="card p-4 border border-amber-500/50 space-y-3">
            <div className="text-xs font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
              Confirmation required · {pending.tool_name}
            </div>
            <div className="text-sm">{pending.summary}</div>
            <pre className="text-xs bg-muted/50 rounded p-2 overflow-x-auto">
              {JSON.stringify(pending.input, null, 2)}
            </pre>
            <div className="flex gap-2">
              <Button onClick={() => decide("apply")} disabled={busy}>
                {busy ? "Working…" : "Apply"}
              </Button>
              <Button variant="ghost" onClick={() => decide("cancel")} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {busy && !pending && (
          <div className="text-sm text-muted-foreground">Agent is thinking…</div>
        )}
        <div ref={endRef} />
      </div>

      {error && (
        <div className="card p-3 border border-red-500/40 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="card p-3 space-y-2 sticky bottom-4">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask or instruct…"
          disabled={busy}
          className="w-full min-h-[72px] rounded-md border border-input bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send();
          }}
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">⌘/Ctrl + Enter to send</span>
          <Button onClick={send} disabled={busy || !input.trim()}>
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
