"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

interface CitedMemory {
  id: number;
  kind: string;
  key: string | null;
  content: string;
  created_at: string;
  source: string;
}

interface AskResponse {
  answer: string;
  cited_memories: CitedMemory[];
}

function renderAnswerWithCitations(answer: string, cited: CitedMemory[]): React.ReactNode {
  const byId = new Map(cited.map((m) => [m.id, m]));
  const parts: React.ReactNode[] = [];
  const regex = /\[m(\d+)\]/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(answer)) !== null) {
    if (match.index > last) parts.push(answer.slice(last, match.index));
    const id = Number(match[1]);
    const mem = byId.get(id);
    parts.push(
      <span
        key={`cite-${key++}`}
        title={mem?.content ?? `Memory #${id}`}
        className="inline-flex items-center rounded bg-accent px-1.5 py-0.5 text-xs font-mono text-accent-foreground align-baseline mx-0.5"
      >
        m{id}
      </span>
    );
    last = match.index + match[0].length;
  }
  if (last < answer.length) parts.push(answer.slice(last));
  return parts;
}

export default function AskPage() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<AskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    if (!question.trim()) return;
    setLoading(true);
    setError(null);
    setResponse(null);
    try {
      const res = await fetch("/api/mail-analyzer/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResponse(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Ask your mailbox</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Natural-language Q&amp;A over every LLM and user decision the assistant has recorded. Answers cite the
          underlying memories.
        </p>
      </header>

      <div className="card p-4 space-y-3">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. What folders did the agent propose? Why did I reject the 'Receipts' rule?"
          className="w-full min-h-[88px] rounded-md border border-input bg-background p-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") ask();
          }}
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">⌘/Ctrl + Enter to send</span>
          <Button onClick={ask} disabled={loading || !question.trim()}>
            {loading ? "Thinking…" : "Ask"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="card p-4 border border-red-500/40 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {response && (
        <div className="space-y-4">
          <div className="card p-4">
            <h2 className="text-sm font-medium text-muted-foreground mb-2">Answer</h2>
            <div className="whitespace-pre-wrap text-sm leading-relaxed">
              {renderAnswerWithCitations(response.answer, response.cited_memories)}
            </div>
          </div>

          {response.cited_memories.length > 0 && (
            <div className="space-y-2">
              <h2 className="text-sm font-medium text-muted-foreground">
                Memories cited ({response.cited_memories.length})
              </h2>
              <ul className="space-y-2">
                {response.cited_memories.map((m) => (
                  <li key={m.id} className="card p-3 text-sm">
                    <div className="flex items-center gap-2 mb-1 text-xs text-muted-foreground">
                      <span className="font-mono">m{m.id}</span>
                      <span>·</span>
                      <span>{m.kind}</span>
                      <span>·</span>
                      <span>{m.source}</span>
                      <span>·</span>
                      <span>{m.created_at.slice(0, 16).replace("T", " ")}</span>
                      {m.key && (
                        <>
                          <span>·</span>
                          <span className="font-mono">{m.key}</span>
                        </>
                      )}
                    </div>
                    <div>{m.content}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
