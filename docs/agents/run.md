---
agent: run
source: src/agent/run.ts
source_sha256: 661b200e33707c88d2013409f5f79e536a6e1293ca4fb500e1c3672b45e2d593
updated: 2026-05-19
---

# run — newsletter digest orchestrator

## Purpose
Orchestrates the flat-file newsletter pipeline: fetch newsletters → summarize
with the configured LLM → persist the summary → optionally email it. This is
the only agent that ties `fetch-emails`, `summarize`, and `send-digest`
together. It does **not** touch the SQLite/Postgres analyzer store.

## Trigger
- CLI: `npm run agent:run`
- HTTP: `POST /api/agents/[id]/run` (UI "Run now" button, Vercel cron)

## Inputs
- `data/config.json` → the `newsletter-summarizer` agent's `settings`:
  `senders`, `lookbackHours`, `maxEmailsPerRun`, `summaryStyle`, `language`,
  `llm` (provider/model/systemPrompt), `deliverEmail`, `deliverEmailTo`.
- Honors the agent `enabled` flag — a disabled agent returns a no-op
  `completed` run.

## Outputs / side-effects
- `data/summaries/<date>.json` — array of `Summary`, newest first (one file/day).
- `data/runs.json` — last 50 `AgentRun` records (status/timing/error/summary).
- `data/debug/<runId>.json` — full prompt + raw LLM response for the run.
- Optionally sends the digest email via `send-digest`.

## Dependencies
- [`fetch-emails`](fetch-emails.md), [`summarize`](summarize.md),
  [`send-digest`](send-digest.md).
- `langsmith/traceable` — the whole run is one `newsletter-agent-run` trace.

## Gotchas
- The CLI entry double-flushes LangSmith batches with a 500 ms gap before
  `process.exit` — the root span lands in the auto-batch queue just after work
  resolves and a single flush races it. Keep that pattern.
- The system prompt is prefixed with `Write in <language>.` from config.
- `data/config.json` is user data; never reset it (see project CLAUDE.md).
