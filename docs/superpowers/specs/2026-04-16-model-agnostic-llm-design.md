---
title: Model-Agnostic LLM via LangChain
date: 2026-04-16
status: approved
---

# Model-Agnostic LLM via LangChain

## Overview

Replace the hand-rolled multi-provider LLM calling code in `src/agent/summarize.ts` with LangChain's unified `BaseChatModel` abstraction. Support four providers: Anthropic, OpenAI, Google Gemini, and Ollama (local). Expose a curated model dropdown in the settings UI instead of a free-text model field.

## Goals

- Any of the four supported providers can be selected and used interchangeably with no code changes at call sites.
- Adding a new provider in the future requires only: installing a LangChain package and adding one `case` to the factory function.
- The UI makes valid model selection obvious without requiring users to memorise model IDs.
- No API keys are stored hardcoded in `config.json`; keys come from environment variables, with the UI field as a fallback.

## Dependencies

Add to `package.json`:

```
@langchain/core
@langchain/anthropic
@langchain/openai
@langchain/google-genai
@langchain/ollama
```

Remove `@anthropic-ai/sdk` from direct dependencies (it becomes a transitive dependency via `@langchain/anthropic`).

## Type Changes (`src/lib/types.ts`)

Update the `llm` block inside `NewsletterAgent.settings`:

```ts
llm: {
  provider: "anthropic" | "openai" | "google" | "ollama";
  apiKey?: string;    // anthropic, openai, google — env var preferred
  baseUrl?: string;   // ollama only; default: http://localhost:11434
  model: string;
  systemPrompt: string;
};
```

The local `LLMConfig` interface in `summarize.ts` mirrors this shape exactly.

## LLM Factory (`src/agent/summarize.ts`)

### Factory function

```ts
function createLLM(config: LLMConfig): BaseChatModel {
  const apiKey = resolveApiKey(config); // throws if required key missing
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
```

### Key resolution

`resolveApiKey` reads from environment variables first, then falls back to `config.apiKey`. For Ollama it returns an empty string (no key needed) without throwing.

| Provider  | Env var            |
|-----------|--------------------|
| anthropic | `ANTHROPIC_API_KEY` |
| openai    | `OPENAI_API_KEY`   |
| google    | `GOOGLE_API_KEY`   |
| ollama    | _(none)_           |

### Invocation

Replace the existing `callLLM` / `callLLMOnce` / manual retry loop with:

```ts
const llm = createLLM(config);
const response = await llm.invoke([
  new SystemMessage(config.systemPrompt),
  new HumanMessage(userMessage),
]);
return response.content as string;
```

LangChain handles retries internally. The hand-rolled retry loop is removed.

## Curated Model List

A constant `PROVIDER_MODELS` maps each provider to its available models. The UI renders this as a dropdown. A final `"custom"` entry in each provider's list reveals a free-text input for unlisted models.

```ts
export const PROVIDER_MODELS = {
  anthropic: [
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    { id: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-6",            label: "Claude Opus 4.6" },
    { id: "custom",                    label: "Custom…" },
  ],
  openai: [
    { id: "gpt-4o",       label: "GPT-4o" },
    { id: "gpt-4o-mini",  label: "GPT-4o mini" },
    { id: "gpt-4-turbo",  label: "GPT-4 Turbo" },
    { id: "custom",       label: "Custom…" },
  ],
  google: [
    { id: "gemini-2.0-flash",  label: "Gemini 2.0 Flash" },
    { id: "gemini-1.5-pro",    label: "Gemini 1.5 Pro" },
    { id: "gemini-1.5-flash",  label: "Gemini 1.5 Flash" },
    { id: "custom",            label: "Custom…" },
  ],
  ollama: [
    { id: "llama3.2",  label: "Llama 3.2" },
    { id: "gemma3",    label: "Gemma 3" },
    { id: "gemma4",    label: "Gemma 4" },
    { id: "mistral",   label: "Mistral" },
    { id: "custom",    label: "Custom…" },
  ],
} as const;
```

This constant lives in `src/lib/models.ts` and is imported by both the UI and (if needed for validation) the agent.

## UI Changes (`src/app/agents/newsletter-summarizer/page.tsx`)

### Provider selector

Four buttons: **Anthropic**, **OpenAI**, **Google**, **Ollama**. Switching provider:
- Resets model to that provider's first listed model ID.
- Clears `apiKey` (to avoid leaking keys between providers).

### Model selector

A `<select>` dropdown populated from `PROVIDER_MODELS[provider]`. If the user picks **Custom…**, a text input appears below the dropdown for entering an arbitrary model ID.

If the current saved model ID is not in the provider's list (e.g. the user previously typed a custom ID), the dropdown shows **Custom…** pre-selected with the saved ID in the text field. The string `"custom"` is never persisted to config — only the actual model ID typed by the user is stored.

### API Key / Base URL field

| Provider  | Field shown                              |
|-----------|------------------------------------------|
| anthropic | API Key (`sk-ant-…`)                     |
| openai    | API Key (`sk-…`)                         |
| google    | API Key (Google AI Studio key)           |
| ollama    | Base URL (default `http://localhost:11434`) |

### Default models on provider switch

| Provider  | Default model           |
|-----------|-------------------------|
| anthropic | `claude-sonnet-4-6`     |
| openai    | `gpt-4o`                |
| google    | `gemini-2.0-flash`      |
| ollama    | `llama3.2`              |

## Security

- Remove the hardcoded API key from `data/config.json`.
- Prefer environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`) over the config file field.
- The UI `apiKey` field remains as a convenience fallback and displays a note: _"Stored locally in config.json. Prefer setting an environment variable."_

## Files Changed

| File | Change |
|------|--------|
| `package.json` | Add LangChain packages, remove `@anthropic-ai/sdk` |
| `src/lib/types.ts` | Add `"google"` \| `"ollama"` to provider union; add `baseUrl` |
| `src/lib/models.ts` | New file: `PROVIDER_MODELS` constant |
| `src/agent/summarize.ts` | Replace DIY LLM calls with LangChain factory |
| `src/app/agents/newsletter-summarizer/page.tsx` | 4-provider UI, model dropdown, conditional API key / base URL field |
| `data/config.json` | Remove hardcoded `apiKey` value |
