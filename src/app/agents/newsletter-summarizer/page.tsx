"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { PROVIDER_MODELS, PROVIDER_DEFAULTS } from "@/lib/models";

interface AgentConfig {
  id: string;
  name: string;
  description: string;
  icon: string;
  enabled: boolean;
  schedule: { enabled: boolean; time: string; days: number[] };
  settings: {
    senders: string[];
    lookbackHours: number;
    maxEmailsPerRun: number;
    summaryStyle: string;
    language: string;
    deliverEmail: boolean;
    deliverEmailTo: string;
    llm: {
      provider: string;
      apiKey?: string;
      baseUrl?: string;
      model: string;
      systemPrompt: string;
    };
  };
}

interface Summary {
  id: string;
  date: string;
  title: string;
  content: string;
  emailCount: number;
  sources: { sender: string; subject: string }[];
  createdAt: string;
}

interface Run {
  id: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function Toggle({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={`w-12 h-6 rounded-full transition-colors relative ${
        enabled ? "bg-accent" : "bg-border"
      }`}
    >
      <div
        className={`w-5 h-5 bg-white rounded-full absolute top-0.5 transition-transform shadow-sm ${
          enabled ? "translate-x-6" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

export default function NewsletterAgentPage() {
  const [agent, setAgent] = useState<AgentConfig | null>(null);
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedSummary, setSelectedSummary] = useState<Summary | null>(null);
  const [tab, setTab] = useState<"overview" | "settings" | "history">(
    "overview"
  );
  const [running, setRunning] = useState(false);
  const [newSender, setNewSender] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "pending" | "saving" | "saved">("idle");
  const savedSnapshot = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadData = useCallback(async () => {
    const [agentRes, summariesRes, runsRes] = await Promise.all([
      fetch("/api/agents/newsletter-summarizer"),
      fetch("/api/summaries"),
      fetch("/api/runs?agentId=newsletter-summarizer"),
    ]);
    setAgent(await agentRes.json());
    const s = await summariesRes.json();
    setSummaries(s);
    setRuns(await runsRes.json());
    if (s.length > 0 && !selectedSummary) setSelectedSummary(s[0]);
  }, [selectedSummary]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleRun() {
    setRunning(true);
    try {
      await fetch("/api/agents/newsletter-summarizer/run", { method: "POST" });
      await loadData();
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    if (!agent) return;
    const current = JSON.stringify(agent);
    if (savedSnapshot.current === null) {
      savedSnapshot.current = current;
      return;
    }
    if (current === savedSnapshot.current) return;
    setSaveStatus("pending");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaveStatus("saving");
      const body = JSON.stringify(agent);
      await fetch("/api/agents/newsletter-summarizer", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
      });
      savedSnapshot.current = body;
      setSaveStatus("saved");
    }, 800);
  }, [agent]);

  function addSender() {
    if (!agent || !newSender.trim()) return;
    setAgent({
      ...agent,
      settings: {
        ...agent.settings,
        senders: [...agent.settings.senders, newSender.trim()],
      },
    });
    setNewSender("");
  }

  function removeSender(idx: number) {
    if (!agent) return;
    setAgent({
      ...agent,
      settings: {
        ...agent.settings,
        senders: agent.settings.senders.filter((_, i) => i !== idx),
      },
    });
  }

  function toggleDay(day: number) {
    if (!agent) return;
    const days = agent.schedule.days.includes(day)
      ? agent.schedule.days.filter((d) => d !== day)
      : [...agent.schedule.days, day].sort();
    setAgent({ ...agent, schedule: { ...agent.schedule, days } });
  }

  if (!agent) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="animate-pulse text-muted">Loading agent...</div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted mb-6">
        <Link href="/" className="hover:text-foreground transition-colors">
          Dashboard
        </Link>
        <span>/</span>
        <span className="text-foreground">{agent.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-4">
          <span className="text-4xl">{agent.icon}</span>
          <div>
            <h1 className="text-2xl font-bold">{agent.name}</h1>
            <p className="text-muted text-sm">{agent.description}</p>
          </div>
        </div>
        <button
          onClick={handleRun}
          disabled={running}
          className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 shadow-sm"
        >
          {running ? "Running..." : "Run Now"}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-border">
        {(["overview", "settings", "history"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? "border-accent text-accent"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* ──── Overview Tab ──── */}
      {tab === "overview" && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Digest list */}
          <div className="lg:col-span-1 space-y-2">
            <h3 className="text-sm font-medium text-muted mb-3">
              Recent Digests
            </h3>
            {summaries.length === 0 ? (
              <p className="text-sm text-muted bg-card border border-border rounded-lg p-4 shadow-sm shadow-shadow">
                No digests yet. Click &quot;Run Now&quot; to create your first
                one.
              </p>
            ) : (
              summaries.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSelectedSummary(s)}
                  className={`w-full text-left p-3 rounded-lg border transition-all text-sm shadow-sm shadow-shadow ${
                    selectedSummary?.id === s.id
                      ? "bg-accent-soft border-accent/30"
                      : "bg-card border-border hover:bg-card-hover"
                  }`}
                >
                  <div className="font-medium truncate">{s.title}</div>
                  <div className="text-xs text-muted mt-1">
                    {s.date} &middot; {s.emailCount} email(s)
                  </div>
                </button>
              ))
            )}
          </div>

          {/* Digest content */}
          <div className="lg:col-span-2">
            {selectedSummary ? (
              <div className="bg-card border border-border rounded-xl p-6 shadow-sm shadow-shadow">
                <div className="flex items-center justify-between mb-4 pb-4 border-b border-border">
                  <div>
                    <h2 className="text-lg font-semibold">
                      {selectedSummary.title}
                    </h2>
                    <p className="text-xs text-muted mt-1">
                      {selectedSummary.date} &middot;{" "}
                      {selectedSummary.emailCount} newsletter(s) &middot;
                      Sources:{" "}
                      {selectedSummary.sources
                        .map((s) => s.sender)
                        .join(", ")}
                    </p>
                  </div>
                </div>
                <div className="prose prose-sm max-w-none">
                  <ReactMarkdown>{selectedSummary.content}</ReactMarkdown>
                </div>
              </div>
            ) : (
              <div className="bg-card border border-border rounded-xl p-8 text-center text-muted shadow-sm shadow-shadow">
                <p className="text-lg mb-1">No digest selected</p>
                <p className="text-sm">
                  Select a digest from the list or run the agent to create one.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ──── Settings Tab ──── */}
      {tab === "settings" && (
        <div className="max-w-2xl space-y-6">
          {/* Auto-save indicator */}
          <div className="flex justify-end text-xs text-muted h-4">
            {saveStatus === "pending" && <span>Unsaved changes…</span>}
            {saveStatus === "saving" && <span>Saving…</span>}
            {saveStatus === "saved" && <span className="text-accent">All changes saved</span>}
          </div>

          {/* Status */}
          <div className="bg-card border border-border rounded-xl p-5 shadow-sm shadow-shadow">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium">Agent Status</h3>
                <p className="text-sm text-muted">
                  Enable or disable this agent
                </p>
              </div>
              <Toggle
                enabled={agent.enabled}
                onToggle={() =>
                  setAgent({ ...agent, enabled: !agent.enabled })
                }
              />
            </div>
          </div>

          {/* Output Language */}
          <div className="bg-card border border-border rounded-xl p-5 shadow-sm shadow-shadow">
            <h3 className="font-medium mb-1">Output Language</h3>
            <p className="text-sm text-muted mb-4">
              Language the digest will be written in (e.g. English, German, French).
            </p>
            <select
              value={agent.settings.language || "English"}
              onChange={(e) =>
                setAgent({
                  ...agent,
                  settings: { ...agent.settings, language: e.target.value },
                })
              }
              className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20"
            >
              {["English", "German", "French", "Spanish", "Italian", "Portuguese", "Dutch", "Japanese", "Chinese"].map(
                (lang) => (
                  <option key={lang} value={lang}>
                    {lang}
                  </option>
                )
              )}
            </select>
          </div>

          {/* Newsletter Senders */}
          <div className="bg-card border border-border rounded-xl p-5 shadow-sm shadow-shadow">
            <h3 className="font-medium mb-1">Newsletter Senders</h3>
            <p className="text-sm text-muted mb-4">
              Add email addresses or sender names to monitor.
            </p>
            <div className="flex gap-2 mb-3">
              <input
                type="text"
                value={newSender}
                onChange={(e) => setNewSender(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addSender()}
                placeholder="e.g. newsletter@example.com"
                className="flex-1 bg-input-bg border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20"
              />
              <button
                onClick={addSender}
                className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors"
              >
                Add
              </button>
            </div>
            <div className="space-y-2">
              {agent.settings.senders.map((sender, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between bg-background-secondary border border-border rounded-lg px-3 py-2"
                >
                  <span className="text-sm">{sender}</span>
                  <button
                    onClick={() => removeSender(idx)}
                    className="text-muted hover:text-danger text-sm transition-colors"
                  >
                    Remove
                  </button>
                </div>
              ))}
              {agent.settings.senders.length === 0 && (
                <p className="text-sm text-muted italic">
                  No senders configured yet.
                </p>
              )}
            </div>
          </div>

          {/* Schedule */}
          <div className="bg-card border border-border rounded-xl p-5 shadow-sm shadow-shadow">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-medium">Schedule</h3>
                <p className="text-sm text-muted">
                  When should this agent run automatically?
                </p>
              </div>
              <Toggle
                enabled={agent.schedule.enabled}
                onToggle={() =>
                  setAgent({
                    ...agent,
                    schedule: {
                      ...agent.schedule,
                      enabled: !agent.schedule.enabled,
                    },
                  })
                }
              />
            </div>
            {agent.schedule.enabled && (
              <>
                <div className="mb-4">
                  <label className="text-sm text-muted block mb-1">Time</label>
                  <input
                    type="time"
                    value={agent.schedule.time}
                    onChange={(e) =>
                      setAgent({
                        ...agent,
                        schedule: { ...agent.schedule, time: e.target.value },
                      })
                    }
                    className="bg-input-bg border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20"
                  />
                </div>
                <div>
                  <label className="text-sm text-muted block mb-2">Days</label>
                  <div className="flex gap-2">
                    {DAY_NAMES.map((name, idx) => (
                      <button
                        key={idx}
                        onClick={() => toggleDay(idx)}
                        className={`w-10 h-10 rounded-lg text-xs font-medium transition-colors ${
                          agent.schedule.days.includes(idx)
                            ? "bg-accent text-white shadow-sm"
                            : "bg-background-secondary border border-border text-muted hover:border-accent"
                        }`}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Advanced Settings */}
          <div className="bg-card border border-border rounded-xl p-5 shadow-sm shadow-shadow">
            <h3 className="font-medium mb-4">Advanced</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-muted block mb-1">
                  Lookback (hours)
                </label>
                <input
                  type="number"
                  value={agent.settings.lookbackHours}
                  onChange={(e) =>
                    setAgent({
                      ...agent,
                      settings: {
                        ...agent.settings,
                        lookbackHours: parseInt(e.target.value) || 24,
                      },
                    })
                  }
                  className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20"
                />
              </div>
              <div>
                <label className="text-sm text-muted block mb-1">
                  Max emails per run
                </label>
                <input
                  type="number"
                  value={agent.settings.maxEmailsPerRun}
                  onChange={(e) =>
                    setAgent({
                      ...agent,
                      settings: {
                        ...agent.settings,
                        maxEmailsPerRun: parseInt(e.target.value) || 20,
                      },
                    })
                  }
                  className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20"
                />
              </div>
            </div>
          </div>

          {/* Email Delivery */}
          <div className="bg-card border border-border rounded-xl p-5 shadow-sm shadow-shadow">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-medium">Email Delivery</h3>
                <p className="text-sm text-muted">
                  Send the digest to your inbox via Apple Mail
                </p>
              </div>
              <Toggle
                enabled={agent.settings.deliverEmail}
                onToggle={() =>
                  setAgent({
                    ...agent,
                    settings: {
                      ...agent.settings,
                      deliverEmail: !agent.settings.deliverEmail,
                    },
                  })
                }
              />
            </div>
            {agent.settings.deliverEmail && (
              <input
                type="email"
                value={agent.settings.deliverEmailTo}
                onChange={(e) =>
                  setAgent({
                    ...agent,
                    settings: {
                      ...agent.settings,
                      deliverEmailTo: e.target.value,
                    },
                  })
                }
                placeholder="your@email.com"
                className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20"
              />
            )}
          </div>

          {/* LLM Provider */}
          <div className="bg-card border border-border rounded-xl p-5 shadow-sm shadow-shadow">
            <h3 className="font-medium mb-1">LLM Provider</h3>
            <p className="text-sm text-muted mb-4">
              Choose which AI provider and model to use for summarization.
            </p>
            <div className="space-y-4">
              {/* Provider buttons */}
              <div>
                <label className="text-sm text-muted block mb-2">
                  Provider
                </label>
                <div className="flex flex-wrap gap-2">
                  {(["anthropic", "openai", "google", "ollama"] as const).map(
                    (provider) => (
                      <button
                        key={provider}
                        onClick={() =>
                          setAgent({
                            ...agent,
                            settings: {
                              ...agent.settings,
                              llm: {
                                ...agent.settings.llm,
                                provider,
                                model: PROVIDER_DEFAULTS[provider],
                                apiKey: "",
                                baseUrl:
                                  provider === "ollama"
                                    ? "http://localhost:11434"
                                    : undefined,
                              },
                            },
                          })
                        }
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                          agent.settings.llm?.provider === provider
                            ? "bg-accent text-white shadow-sm"
                            : "bg-background-secondary border border-border text-muted hover:border-accent"
                        }`}
                      >
                        {provider === "anthropic"
                          ? "Anthropic"
                          : provider === "openai"
                            ? "OpenAI"
                            : provider === "google"
                              ? "Google"
                              : "Ollama (Local)"}
                      </button>
                    )
                  )}
                </div>
              </div>

              {/* Model dropdown */}
              <div>
                <label className="text-sm text-muted block mb-1">Model</label>
                {(() => {
                  const provider =
                    agent.settings.llm?.provider ?? "anthropic";
                  const models = PROVIDER_MODELS[provider] ?? [];
                  const currentModel = agent.settings.llm?.model ?? "";
                  const isKnown = models.some(
                    (m) => m.id === currentModel && m.id !== "custom"
                  );
                  const selectValue = isKnown ? currentModel : "custom";

                  return (
                    <>
                      <select
                        value={selectValue}
                        onChange={(e) => {
                          const value = e.target.value;
                          if (value === "custom") {
                            setAgent({
                              ...agent,
                              settings: {
                                ...agent.settings,
                                llm: {
                                  ...agent.settings.llm,
                                  model: "",
                                },
                              },
                            });
                            return;
                          }
                          setAgent({
                            ...agent,
                            settings: {
                              ...agent.settings,
                              llm: {
                                ...agent.settings.llm,
                                model: value,
                              },
                            },
                          });
                        }}
                        className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20"
                      >
                        {models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                      {selectValue === "custom" && (
                        <input
                          type="text"
                          value={currentModel}
                          onChange={(e) =>
                            setAgent({
                              ...agent,
                              settings: {
                                ...agent.settings,
                                llm: {
                                  ...agent.settings.llm,
                                  model: e.target.value,
                                },
                              },
                            })
                          }
                          placeholder="Enter model ID"
                          className="mt-2 w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20 font-mono"
                        />
                      )}
                    </>
                  );
                })()}
              </div>

              {/* API Key (cloud providers) or Base URL (Ollama) */}
              {agent.settings.llm?.provider === "ollama" ? (
                <div>
                  <label className="text-sm text-muted block mb-1">
                    Base URL
                  </label>
                  <input
                    type="text"
                    value={
                      agent.settings.llm?.baseUrl ?? "http://localhost:11434"
                    }
                    onChange={(e) =>
                      setAgent({
                        ...agent,
                        settings: {
                          ...agent.settings,
                          llm: {
                            ...agent.settings.llm,
                            baseUrl: e.target.value,
                          },
                        },
                      })
                    }
                    placeholder="http://localhost:11434"
                    className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20 font-mono"
                  />
                  <p className="text-xs text-muted mt-1">
                    URL of your local Ollama server. Default:
                    http://localhost:11434
                  </p>
                </div>
              ) : (
                <div>
                  <label className="text-sm text-muted block mb-1">
                    API Key
                  </label>
                  <input
                    type="password"
                    value={agent.settings.llm?.apiKey ?? ""}
                    onChange={(e) =>
                      setAgent({
                        ...agent,
                        settings: {
                          ...agent.settings,
                          llm: {
                            ...agent.settings.llm,
                            apiKey: e.target.value,
                          },
                        },
                      })
                    }
                    placeholder={
                      agent.settings.llm?.provider === "openai"
                        ? "sk-…"
                        : agent.settings.llm?.provider === "google"
                          ? "AIza…"
                          : "sk-ant-…"
                    }
                    className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20 font-mono"
                  />
                  <p className="text-xs text-muted mt-1">
                    Stored locally in config.json. Prefer setting an environment
                    variable (
                    {agent.settings.llm?.provider === "openai"
                      ? "OPENAI_API_KEY"
                      : agent.settings.llm?.provider === "google"
                        ? "GOOGLE_API_KEY"
                        : "ANTHROPIC_API_KEY"}
                    ).
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* System Prompt */}
          <div className="bg-card border border-border rounded-xl p-5 shadow-sm shadow-shadow">
            <h3 className="font-medium mb-1">System Prompt</h3>
            <p className="text-sm text-muted mb-3">
              The instructions sent to the AI for how to summarize newsletters.
            </p>
            <textarea
              value={agent.settings.llm?.systemPrompt || ""}
              onChange={(e) =>
                setAgent({
                  ...agent,
                  settings: {
                    ...agent.settings,
                    llm: {
                      ...agent.settings.llm,
                      systemPrompt: e.target.value,
                    },
                  },
                })
              }
              rows={14}
              className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20 font-mono leading-relaxed resize-y"
              placeholder="Enter the system prompt for the AI..."
            />
          </div>

        </div>
      )}

      {/* ──── History Tab ──── */}
      {tab === "history" && (
        <div>
          {runs.length === 0 ? (
            <div className="bg-card border border-border rounded-xl p-8 text-center text-muted shadow-sm shadow-shadow">
              <p className="text-sm">No runs yet.</p>
            </div>
          ) : (
            <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm shadow-shadow">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted">
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Started</th>
                    <th className="px-4 py-3 font-medium">Duration</th>
                    <th className="px-4 py-3 font-medium">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => {
                    const duration = run.completedAt
                      ? `${Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)}s`
                      : "...";
                    return (
                      <tr
                        key={run.id}
                        className="border-b border-border last:border-0"
                      >
                        <td className="px-4 py-3">
                          <span
                            className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                              run.status === "completed"
                                ? "bg-success-soft text-success"
                                : run.status === "failed"
                                  ? "bg-danger-soft text-danger"
                                  : "bg-warning-soft text-warning"
                            }`}
                          >
                            {run.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-muted">
                          {new Date(run.startedAt).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-muted">{duration}</td>
                        <td className="px-4 py-3 text-muted">
                          {run.error && (
                            <span className="text-danger">{run.error}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
