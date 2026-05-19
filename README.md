# Mail Intelligence (M.I.)

**Live demo:** https://mail-intelligence.vercel.app

## What this project is

Mail Intelligence is an AI agent that takes over the tedious work of organizing
an email mailbox. A user connects their inbox (Gmail, Outlook, or any IMAP
account) and the agent scans the whole mailbox, learns how the person actually
uses email through a short conversational onboarding, and then proposes a clean
folder structure, routing rules, and a triage of what is important versus noise.
Every change is conversational: the user talks to the agent in plain language,
the agent explains what it found and *why*, and nothing that modifies the
mailbox happens without the user's explicit confirmation. The problem it solves
is inbox overload — most people have thousands of unsorted emails and no time
to build and maintain a filing system by hand. Mail Intelligence does that
analysis and upkeep automatically while keeping the human in control. It works
by combining a multi-provider LLM (via LangChain) with an agentic
function-calling loop: read-only tools (count senders, list folders, inspect
rules) run automatically so the agent can reason about the mailbox, while
mutating tools (create a rule, move messages, rename a folder) pause the loop
and require a one-click approval from the user before they execute.

## The problem

A typical mailbox has years of newsletters, receipts, notifications and real
correspondence mixed together. Manually building filters and folders is slow,
and they go stale the moment your email habits change. Mail Intelligence treats
mailbox organization as an ongoing, conversational task instead of a one-time
manual chore.

## How it works

1. **Sign in** — Supabase email auth. Each user's data is isolated at the
   database level with Postgres Row-Level Security (multi-tenant by design).
2. **Connect a mailbox** — Gmail / Outlook via OAuth 2.0, or generic IMAP.
   Credentials are never stored in the repo; OAuth refresh tokens live in
   environment variables, not in code or version control.
3. **Scan** — the mailbox is read **read-only** and indexed (senders,
   volume, categories) into Postgres.
4. **Onboarding chat** — a short guided conversation builds a "persona" of how
   the user wants their mail organized.
5. **Agent loop** — a streaming LangChain agent reasons over the mailbox using
   ~20 function-calling tools. Read tools run automatically; any tool that
   changes the mailbox is shown to the user as an Apply / Cancel card and only
   runs on explicit confirmation.
6. **Automation** — scheduled jobs (scan, triage, classify, spam-rescan) keep
   the analysis fresh via Vercel Cron + Inngest.

## Tech stack & learning application

| Area | What was used |
|------|----------------|
| LLM orchestration | **LangChain** (`@langchain/core`) with a single `createLLM()` factory |
| LLM providers | Anthropic (default), OpenAI, Google Gemini, Ollama — swappable from config |
| Agent design | Streaming agentic loop with **function/tool calling**; read vs. mutating tool separation with human-in-the-loop confirmation |
| Prompt engineering | Structured system prompts, JSON tool specs, prompt-injection guardrails, a rolling conversation-summary memory to bound context |
| Observability | LangSmith tracing on every turn and tool call |
| App framework | Next.js 16 (App Router), React 19, TypeScript, Tailwind 4 |
| Data | Supabase Postgres with Row-Level Security; SQLite for local dev |
| Deployment | Vercel (production), Vercel Cron + Inngest for scheduled work |
| Testing / evals | Unit tests (`node --test`) and a dedicated **prompt-injection eval suite** (`evals/prompt-injection`) |

## Ethical & privacy considerations

This project was built with the privacy and safety risks of an
inbox-reading AI front of mind:

- **Read-by-default, never silently mutate.** The mailbox is only ever read
  during analysis. Any action that changes the mailbox requires explicit
  per-action user confirmation in the UI — the agent cannot move or delete mail
  on its own.
- **Tenant isolation.** Every table enforces Postgres Row-Level Security keyed
  to the authenticated user, so one user can never read another's mail data.
- **No secrets in the repo.** API keys, mail credentials and OAuth refresh
  tokens are environment variables only; `.env*` and user data files are
  gitignored.
- **Prompt-injection defense.** Email content is untrusted input. It is wrapped
  in data blocks with an explicit guardrail instructing the model to treat it
  as data, not instructions, and a dedicated eval suite tests these attacks
  (`npm run eval:injection`).
- **Data deletion.** Users can delete their account and associated data.
- **Least-privilege mail access.** OAuth scopes and IMAP usage are read-only
  for analysis; no broader access than the feature needs.

## Running locally

```bash
npm install
npm run dev          # Next.js dev server → http://localhost:3000
npm run lint         # ESLint
npm test             # unit tests
npm run eval:injection   # prompt-injection eval suite
```

### Required environment variables (`.env.local`, never committed)

| Purpose | Variables |
|---------|-----------|
| LLM | `ANTHROPIC_API_KEY` (default) — or `OPENAI_API_KEY` / `GOOGLE_API_KEY`; Ollama needs none |
| Database / auth | Supabase project URL + keys, `DATABASE_URL` |
| Mail (one of) | IMAP: `IMAP_HOST/USER/PASSWORD/PORT` · Gmail: `GOOGLE_CLIENT_ID/SECRET` · Outlook: `MS_CLIENT_ID/SECRET/TENANT_ID` |
| Optional tracing | `LANGCHAIN_TRACING_V2=true`, `LANGCHAIN_API_KEY`, `LANGCHAIN_PROJECT` |

## Project structure

- `src/lib/chat-agent.ts` — the streaming agentic loop (the core of the project)
- `src/lib/chat-tools.ts` — the function-calling tool specs (read vs. mutating)
- `src/lib/prompt-safety.ts` — prompt-injection guardrails
- `src/agent/` — standalone analysis jobs (scan, triage, classify, audit)
- `src/agent/summarize.ts` — `createLLM()` multi-provider LangChain factory
- `src/app/` — Next.js App Router UI + API routes
- `db/migrations/` — Postgres schema incl. Row-Level Security policies
- `evals/prompt-injection/` — adversarial prompt-injection test cases
