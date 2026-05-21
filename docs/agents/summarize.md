---
agent: summarize
source: src/agent/summarize.ts
source_sha256: b99db3b95ed70d0653679d705403bb13cc47805808897d67073c5f0e8ec3781f
updated: 2026-05-19
---

# summarize — LLM factory & digest generator

## Purpose
Two roles: (1) `createLLM(config)` — the **single** factory that builds the
right LangChain `BaseChatModel` for every agent in the project; (2)
`summarizeNewsletters(...)` — turns fetched newsletters into a structured,
markdown-rendered digest.

## Trigger
Library only. `createLLM` is imported by `classify-senders`,
`propose-structure`, and here; `summarizeNewsletters` is called by
[`run.ts`](run.md).

## Inputs
- `createLLM`: `LLMConfig` (`provider`, `model`, keys, `systemPrompt`,
  `baseUrl`). API-key precedence: env var → per-provider config → `apiKey`;
  Ollama needs no key.
- `summarizeNewsletters`: `Email[]`, `style` (brief/detailed/bullet-points),
  `LLMConfig`.

## Outputs / side-effects
- `SummarizeResult`: the `Summary`, the system prompt, the user message, and
  the raw structured response. No persistence (the caller saves). Empty input
  yields a "No newsletters found" summary.

## Dependencies
- `@langchain/{anthropic,openai,google-genai,ollama}`, `zod`,
  `prompt-safety` (`withGuardrail`, `wrapEmail`, `sanitizeSubject`),
  `langsmith/traceable`.

## Gotchas
- **Adding a provider = a new `case` here + a model list in
  `src/lib/models.ts`. Nowhere else.** (Project convention.)
- Output is `withStructuredOutput(DigestSchema)`; the prompt forbids inventing
  URLs and instructs inline `[text](url)` / `![alt](url)` placement — do not
  weaken this.
- `temperature: 0` for all providers (deterministic digests).
