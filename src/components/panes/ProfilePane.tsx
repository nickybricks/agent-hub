"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useRevalidate } from "@/components/DataSync";

interface Memory {
  id: number;
  kind: string;
  key: string | null;
  content: string;
  created_at: string;
}

interface ProfileData {
  persona: Memory | null;
  prefs: Memory[];
  memories: Memory[];
  activity: Memory[];
}

/** "onboarding:cleanup_aggressiveness" → "Cleanup aggressiveness" */
function humanizeKey(key: string | null): string {
  if (!key) return "";
  return key
    .replace(/^onboarding:/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^\s*\w/, (c) => c.toUpperCase())
    .trim();
}

export default function ProfilePane({ active }: { active: boolean }) {
  const [data, setData] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMemories, setShowMemories] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);

  async function rebuild() {
    if (!confirm("Rebuild your profile? This restarts onboarding in the chat. Your current persona is kept in history.")) return;
    setRebuilding(true);
    setError(null);
    try {
      const res = await fetch("/api/mail-analyzer/onboarding/reset", { method: "POST" });
      if (!res.ok) throw new Error();
      window.location.href = "/app?rebuild=1";
    } catch {
      setError("Couldn’t start a rebuild.");
      setRebuilding(false);
    }
  }

  async function load() {
    try {
      const d: ProfileData = await fetch("/api/mail-analyzer/profile").then((r) => r.json());
      setData(d);
      setDraft(d.persona?.content ?? "");
    } catch {
      setError("Couldn’t load your profile.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useRevalidate(active, load);

  async function savePersona() {
    if (!draft.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/mail-analyzer/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft.trim() }),
      });
      if (!res.ok) throw new Error();
      await load();
    } catch {
      setError("Save failed. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-8 py-10">
        <p className="text-sm text-muted">Loading…</p>
      </div>
    );
  }

  const persona = data?.persona ?? null;
  const prefs = data?.prefs ?? [];
  const memories = data?.memories ?? [];
  const activity = data?.activity ?? [];
  const dirty = draft.trim() !== (persona?.content ?? "").trim();

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-10">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="mb-1 text-2xl font-semibold tracking-tight">Profile</h1>
          <p className="text-sm text-muted">
            What the assistant has learned about you and your mailbox.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={rebuild}
          disabled={rebuilding}
          title="Restart onboarding in the chat to rebuild your persona"
        >
          {rebuilding ? "Starting…" : "Rebuild profile"}
        </Button>
      </div>

      {/* Persona */}
      <section className="card flex flex-col gap-3 p-5">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Your persona</h2>
          <p className="text-xs text-muted">
            A narrative summary that steers folder proposals and triage. Edit anything that’s
            off — saving keeps the old version in history.
          </p>
        </div>
        {persona || draft ? (
          <>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={8}
              className="w-full rounded-md border border-input bg-background p-3 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="No persona yet — it’s written during onboarding."
            />
            <div className="flex items-center gap-3">
              <Button onClick={savePersona} disabled={!dirty || saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
              {dirty && !saving && (
                <span className="text-xs text-muted">Unsaved changes</span>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm text-muted">
            No persona yet. The assistant builds one during onboarding — connect your mailbox
            and answer a few questions in the chat to get started.
          </p>
        )}
      </section>

      {/* Questionnaire answers */}
      <section className="card flex flex-col gap-3 p-5">
        <h2 className="text-sm font-semibold tracking-tight">
          Questionnaire answers{" "}
          <span className="font-normal text-muted">({prefs.length})</span>
        </h2>
        {prefs.length === 0 ? (
          <p className="text-sm text-muted">None yet.</p>
        ) : (
          <dl className="flex flex-col divide-y divide-border">
            {prefs.map((p) => (
              <div key={p.id} className="flex flex-col gap-0.5 py-2.5 first:pt-0 last:pb-0">
                <dt className="text-xs font-medium uppercase tracking-wide text-muted">
                  {humanizeKey(p.key)}
                </dt>
                <dd className="text-sm leading-relaxed">{p.content}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {/* Other memories — progressive disclosure */}
      <section className="card flex flex-col gap-3 p-5">
        <button
          onClick={() => setShowMemories((v) => !v)}
          className="flex items-center gap-2 text-left text-sm font-semibold tracking-tight"
        >
          <span className="text-muted">{showMemories ? "▾" : "▸"}</span>
          Learned memories{" "}
          <span className="font-normal text-muted">({memories.length})</span>
        </button>
        {showMemories &&
          (memories.length === 0 ? (
            <p className="text-sm text-muted">Nothing learned yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {memories.map((m) => (
                <li key={m.id} className="text-sm">
                  <span className="mr-2 text-xs font-medium uppercase tracking-wide text-muted">
                    {m.kind}
                  </span>
                  {m.content}
                </li>
              ))}
            </ul>
          ))}
      </section>

      {/* Activity log — proposal/apply audit trail, deep progressive disclosure */}
      <section className="card flex flex-col gap-3 p-5">
        <button
          onClick={() => setShowActivity((v) => !v)}
          className="flex items-center gap-2 text-left text-sm font-semibold tracking-tight"
        >
          <span className="text-muted">{showActivity ? "▾" : "▸"}</span>
          Activity log{" "}
          <span className="font-normal text-muted">({activity.length})</span>
        </button>
        {showActivity &&
          (activity.length === 0 ? (
            <p className="text-sm text-muted">No activity yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {activity.slice(0, 100).map((m) => (
                <li key={m.id} className="text-xs text-muted">
                  <span className="mr-2 font-medium uppercase tracking-wide">
                    {m.kind.replace(/_/g, " ")}
                  </span>
                  <span className="line-clamp-2">{m.content}</span>
                </li>
              ))}
            </ul>
          ))}
      </section>

      {error && (
        <div className="card border border-red-500/40 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}
    </div>
  );
}
