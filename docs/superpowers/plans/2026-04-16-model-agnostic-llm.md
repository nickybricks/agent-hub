# Model-Agnostic LLM via LangChain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-rolled multi-provider LLM code with LangChain's `BaseChatModel` abstraction, supporting Anthropic, OpenAI, Google Gemini, and Ollama with a curated model dropdown in the UI.

**Architecture:** A `createLLM(config)` factory in `summarize.ts` returns a `BaseChatModel` for whichever provider is configured. A shared `PROVIDER_MODELS` constant in `src/lib/models.ts` drives both the UI dropdown and provider defaults. The settings UI gains a fourth provider (Google), a model `<select>`, and a conditional Base URL field for Ollama.

**Tech Stack:** LangChain (`@langchain/core`, `@langchain/anthropic`, `@langchain/openai`, `@langchain/google-genai`, `@langchain/ollama`), Next.js 16, TypeScript.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `package.json` | Modify | Add LangChain packages, remove `@anthropic-ai/sdk` |
| `src/lib/types.ts` | Modify | Add `"google"` \| `"ollama"` to provider union; add `baseUrl?` |
| `src/lib/models.ts` | **Create** | `PROVIDER_MODELS` constant + `PROVIDER_DEFAULTS` map |
| `src/agent/summarize.ts` | Modify | Replace DIY LLM calls with LangChain factory + `invoke()` |
| `src/app/agents/newsletter-summarizer/page.tsx` | Modify | 4-provider UI, model dropdown, conditional credential field |
| `data/config.json` | Modify | Remove hardcoded `apiKey` value |

---

## Task 1: Install LangChain Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install LangChain packages and remove the direct Anthropic SDK**

```bash
npm install @langchain/core @langchain/anthropic @langchain/openai @langchain/google-genai @langchain/ollama
npm uninstall @anthropic-ai/sdk
```

- [ ] **Step 2: Verify install succeeded**

```bash
npm ls @langchain/core @langchain/anthropic @langchain/openai @langchain/google-genai @langchain/ollama
```

Expected: all five packages listed without errors.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add LangChain providers, remove direct @anthropic-ai/sdk"
```

---

## Task 2: Update Types

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Update the `llm` block in `NewsletterAgent`**

Replace the existing `llm` block inside `NewsletterAgent.settings` (currently lines 22–29 of `src/lib/types.ts`):

```ts
export interface NewsletterAgent extends AgentConfig {
  settings: {
    senders: string[];
    lookbackHours: number;
    maxEmailsPerRun: number;
    summaryStyle: "brief" | "detailed" | "bullet-points";
    deliverEmail: boolean;
    deliverEmailTo: string;
    llm: {
      provider: "anthropic" | "openai" | "google" | "ollama";
      apiKey?: string;    // anthropic, openai, google — env var preferred
      baseUrl?: string;   // ollama only; default: http://localhost:11434
      model: string;
      systemPrompt: string;
    };
  };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "types: add google/ollama providers and baseUrl to LLM config"
```

---

## Task 3: Create the PROVIDER_MODELS Constant

**Files:**
- Create: `src/lib/models.ts`

- [ ] **Step 1: Create `src/lib/models.ts` with the curated model list and provider defaults**

```ts
export interface ModelOption {
  id: string;
  label: string;
}

export const PROVIDER_MODELS: Record<string, ModelOption[]> = {
  anthropic: [
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    { id: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-6",           label: "Claude Opus 4.6" },
    { id: "custom",                    label: "Custom…" },
  ],
  openai: [
    { id: "gpt-4o",      label: "GPT-4o" },
    { id: "gpt-4o-mini", label: "GPT-4o mini" },
    { id: "gpt-4-turbo", label: "GPT-4 Turbo" },
    { id: "custom",      label: "Custom…" },
  ],
  google: [
    { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
    { id: "gemini-1.5-pro",   label: "Gemini 1.5 Pro" },
    { id: "gemini-1.5-flash", label: "Gemini 1.5 Flash" },
    { id: "custom",           label: "Custom…" },
  ],
  ollama: [
    { id: "llama3.2", label: "Llama 3.2" },
    { id: "gemma3",   label: "Gemma 3" },
    { id: "gemma4",   label: "Gemma 4" },
    { id: "mistral",  label: "Mistral" },
    { id: "custom",   label: "Custom…" },
  ],
};

export const PROVIDER_DEFAULTS: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openai:    "gpt-4o",
  google:    "gemini-2.0-flash",
  ollama:    "llama3.2",
};
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/models.ts
git commit -m "feat: add PROVIDER_MODELS and PROVIDER_DEFAULTS constants"
```

---

## Task 4: Refactor `summarize.ts` to Use LangChain

**Files:**
- Modify: `src/agent/summarize.ts`

- [ ] **Step 1: Replace the entire file content**

Overwrite `src/agent/summarize.ts` with the following:

```ts
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOllama } from "@langchain/ollama";
import { Email, Summary } from "../lib/types";
import { randomUUID } from "crypto";

interface LLMConfig {
  provider: "anthropic" | "openai" | "google" | "ollama";
  apiKey?: string;
  baseUrl?: string;
  model: string;
  systemPrompt: string;
}

function resolveApiKey(config: LLMConfig): string {
  if (config.provider === "ollama") return "";
  const envKey =
    config.provider === "openai"
      ? process.env.OPENAI_API_KEY
      : config.provider === "google"
        ? process.env.GOOGLE_API_KEY
        : process.env.ANTHROPIC_API_KEY;
  const key = envKey || config.apiKey;
  if (!key) {
    const envVarName =
      config.provider === "openai"
        ? "OPENAI_API_KEY"
        : config.provider === "google"
          ? "GOOGLE_API_KEY"
          : "ANTHROPIC_API_KEY";
    throw new Error(
      `No API key found for provider "${config.provider}". Set ${envVarName} in your environment or add apiKey to config.`
    );
  }
  return key;
}

function createLLM(config: LLMConfig): BaseChatModel {
  const apiKey = resolveApiKey(config);
  switch (config.provider) {
    case "anthropic":
      return new ChatAnthropic({ apiKey, model: config.model });
    case "openai":
      return new ChatOpenAI({ apiKey, model: config.model });
    case "google":
      return new ChatGoogleGenerativeAI({ apiKey, model: config.model });
    case "ollama":
      return new ChatOllama({
        baseUrl: config.baseUrl ?? "http://localhost:11434",
        model: config.model,
      });
  }
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: "text"; text: string } => c?.type === "text")
      .map((c) => c.text)
      .join("");
  }
  return "";
}

export async function summarizeNewsletters(
  emails: Email[],
  style: "brief" | "detailed" | "bullet-points",
  llmConfig: LLMConfig
): Promise<Summary> {
  if (emails.length === 0) {
    return {
      id: randomUUID(),
      agentId: "newsletter-summarizer",
      date: new Date().toISOString().split("T")[0],
      title: "No newsletters found",
      content: "No newsletter emails were found in the configured time window.",
      emailCount: 0,
      sources: [],
      createdAt: new Date().toISOString(),
    };
  }

  const styleInstructions = {
    brief:
      "Create a brief, concise summary (2-3 paragraphs max). Focus only on the most important highlights.",
    detailed:
      "Create a detailed summary with sections for each major topic. Include context and analysis where relevant.",
    "bullet-points":
      "Create a well-organized bullet-point summary. Group related items under topic headings.",
  };

  const emailContents = emails
    .map((e, i) => {
      const linksSection =
        e.links.length > 0
          ? `\nLinks found in this email:\n${e.links.map((l, j) => `  [${j + 1}] ${l}`).join("\n")}\n`
          : "";
      return `--- Newsletter ${i + 1} ---\nFrom: ${e.sender}\nSubject: ${e.subject}\nDate: ${e.date}\n\n${e.body}${linksSection}`;
    })
    .join("\n\n");

  const userMessage = `${styleInstructions[style]}\n\nHere are today's newsletters:\n\n${emailContents}`;

  const llm = createLLM(llmConfig);
  const response = await llm.invoke([
    new SystemMessage(llmConfig.systemPrompt),
    new HumanMessage(userMessage),
  ]);

  const content = extractText(response.content);

  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch
    ? titleMatch[1]
    : `AI News Digest - ${new Date().toLocaleDateString()}`;

  return {
    id: randomUUID(),
    agentId: "newsletter-summarizer",
    date: new Date().toISOString().split("T")[0],
    title,
    content,
    emailCount: emails.length,
    sources: emails.map((e) => ({ sender: e.sender, subject: e.subject })),
    createdAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/agent/summarize.ts
git commit -m "feat: replace DIY LLM calls with LangChain factory (4 providers)"
```

---

## Task 5: Update the Settings UI

**Files:**
- Modify: `src/app/agents/newsletter-summarizer/page.tsx`

- [ ] **Step 1: Add PROVIDER_MODELS/PROVIDER_DEFAULTS import and update the AgentConfig interface**

At the top of the file, add the import after the `"use client"` directive:

```ts
import { PROVIDER_MODELS, PROVIDER_DEFAULTS } from "@/lib/models";
```

Replace the `AgentConfig` interface `llm` block (currently lines 21–26):

```ts
    llm: {
      provider: string;
      apiKey?: string;
      baseUrl?: string;
      model: string;
      systemPrompt: string;
    };
```

- [ ] **Step 2: Replace the entire LLM Provider settings card**

Find the `{/* LLM Provider */}` comment block (roughly lines 488–583) and replace it with:

```tsx
          {/* LLM Provider */}
          <div className="bg-card border border-border rounded-xl p-5 shadow-sm shadow-shadow">
            <h3 className="font-medium mb-1">LLM Provider</h3>
            <p className="text-sm text-muted mb-4">
              Choose which AI provider and model to use for summarization.
            </p>
            <div className="space-y-4">
              {/* Provider buttons */}
              <div>
                <label className="text-sm text-muted block mb-2">Provider</label>
                <div className="flex flex-wrap gap-2">
                  {(["anthropic", "openai", "google", "ollama"] as const).map((provider) => (
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
                              baseUrl: provider === "ollama" ? "http://localhost:11434" : undefined,
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
                      {provider === "anthropic" ? "Anthropic" :
                       provider === "openai" ? "OpenAI" :
                       provider === "google" ? "Google" : "Ollama (Local)"}
                    </button>
                  ))}
                </div>
              </div>

              {/* Model dropdown */}
              <div>
                <label className="text-sm text-muted block mb-1">Model</label>
                {(() => {
                  const provider = agent.settings.llm?.provider ?? "anthropic";
                  const models = PROVIDER_MODELS[provider] ?? [];
                  const currentModel = agent.settings.llm?.model ?? "";
                  const isKnown = models.some((m) => m.id === currentModel && m.id !== "custom");
                  const selectValue = isKnown ? currentModel : "custom";

                  return (
                    <>
                      <select
                        value={selectValue}
                        onChange={(e) => {
                          if (e.target.value === "custom") return; // wait for text input
                          setAgent({
                            ...agent,
                            settings: {
                              ...agent.settings,
                              llm: { ...agent.settings.llm, model: e.target.value },
                            },
                          });
                        }}
                        className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20"
                      >
                        {models.map((m) => (
                          <option key={m.id} value={m.id}>{m.label}</option>
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
                                llm: { ...agent.settings.llm, model: e.target.value },
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
                  <label className="text-sm text-muted block mb-1">Base URL</label>
                  <input
                    type="text"
                    value={agent.settings.llm?.baseUrl ?? "http://localhost:11434"}
                    onChange={(e) =>
                      setAgent({
                        ...agent,
                        settings: {
                          ...agent.settings,
                          llm: { ...agent.settings.llm, baseUrl: e.target.value },
                        },
                      })
                    }
                    placeholder="http://localhost:11434"
                    className="w-full bg-input-bg border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20 font-mono"
                  />
                  <p className="text-xs text-muted mt-1">
                    URL of your local Ollama server. Default: http://localhost:11434
                  </p>
                </div>
              ) : (
                <div>
                  <label className="text-sm text-muted block mb-1">API Key</label>
                  <input
                    type="password"
                    value={agent.settings.llm?.apiKey ?? ""}
                    onChange={(e) =>
                      setAgent({
                        ...agent,
                        settings: {
                          ...agent.settings,
                          llm: { ...agent.settings.llm, apiKey: e.target.value },
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
                    Stored locally in config.json. Prefer setting an environment variable
                    ({agent.settings.llm?.provider === "openai"
                      ? "OPENAI_API_KEY"
                      : agent.settings.llm?.provider === "google"
                        ? "GOOGLE_API_KEY"
                        : "ANTHROPIC_API_KEY"}).
                  </p>
                </div>
              )}
            </div>
          </div>
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Start the dev server and manually verify the UI**

```bash
npm run dev
```

Open `http://localhost:3000/agents/newsletter-summarizer` → Settings tab. Verify:
- Four provider buttons render (Anthropic, OpenAI, Google, Ollama (Local))
- Switching provider updates the model dropdown options
- Selecting a non-custom model hides the custom text field
- Selecting "Custom…" reveals the custom text field
- Ollama shows Base URL field; all others show API Key field
- The env var name in the hint updates per provider

- [ ] **Step 5: Commit**

```bash
git add src/app/agents/newsletter-summarizer/page.tsx
git commit -m "feat: 4-provider UI with model dropdown and conditional credential field"
```

---

## Task 6: Remove Hardcoded API Key from config.json

**Files:**
- Modify: `data/config.json`

- [ ] **Step 1: Clear the `apiKey` value in config.json**

In `data/config.json`, find the `"llm"` block and set `"apiKey"` to an empty string:

```json
"llm": {
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "apiKey": "",
  "systemPrompt": "..."
}
```

Keep all other fields intact. Only change `"apiKey"` from the live key to `""`.

- [ ] **Step 2: Set the API key via environment variable instead**

Confirm `ANTHROPIC_API_KEY` is set in your shell (or `.env.local`):

```bash
echo $ANTHROPIC_API_KEY
```

Expected: your key printed (not empty). If missing, add to `.env.local`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

- [ ] **Step 3: Smoke-test the agent runs successfully with the env var**

```bash
npm run agent:run
```

Expected: agent completes successfully — `"Newsletter agent run complete!"` printed with no API key errors.

- [ ] **Step 4: Commit**

```bash
git add data/config.json
git commit -m "security: remove hardcoded API key from config.json"
```

---

## Self-Review Checklist

After completing all tasks, verify:

- [ ] `npx tsc --noEmit` passes with no errors
- [ ] `npm run agent:run` completes successfully using the Anthropic provider
- [ ] In the UI, switching to Google shows the correct model list and `GOOGLE_API_KEY` hint
- [ ] Switching to Ollama hides the API key and shows the Base URL field
- [ ] Selecting "Custom…" in any provider's dropdown reveals the free-text model input
- [ ] `data/config.json` contains no live API key value
