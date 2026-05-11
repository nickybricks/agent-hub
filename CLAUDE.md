# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

## Project: mail-workflow

A Next.js 16 app (React 19, Tailwind 4, TypeScript) that fetches newsletters from Apple Mail via AppleScript, summarizes them with an LLM, and serves a digest UI.

### Architecture

- **`src/agent/`** — standalone agent scripts run via `npx tsx` or launchd
  - `fetch-emails.ts` — AppleScript bridge to Apple Mail (macOS only)
  - `summarize.ts` — LangChain factory: builds the right `BaseChatModel` from config and invokes it
  - `send-digest.ts` — sends email digest via AppleScript
  - `run.ts` — orchestrates fetch → summarize → save → (optional) send; also the CLI entry point
- **`src/app/api/`** — Next.js App Router route handlers (settings, runs, summaries, agent trigger)
- **`src/lib/`** — shared types (`types.ts`), flat-file data helpers (`data.ts`), model constants (`models.ts`)
- **`data/`** — flat-file persistence: `config.json` (agent config), `runs.json`, `summaries/YYYY-MM-DD.json`
- **`scripts/`** — shell scripts for launchd scheduling (`install-schedule.sh`, `uninstall-schedule.sh`, `run-agent.sh`)

### Key conventions

- **LLM abstraction:** all provider switching goes through `createLLM()` in `summarize.ts`. New providers → add a `case` there and a model list in `src/lib/models.ts`. Don't add provider logic elsewhere.
- **API keys:** env vars take precedence over config (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`). Config `apiKey` is a fallback. Ollama needs no key.
- **Persistence:** flat JSON files, no database. `data/config.json` is the source of truth for agent settings. `data/summaries/` stores one file per day (array of `Summary`). `data/runs.json` keeps the last 50 runs.
- **Types:** `NewsletterAgent`, `Email`, `Summary`, `AgentRun` are defined in `src/lib/types.ts`. Don't duplicate or inline them.
- **No tests currently.** When adding features, manually verify via `npm run agent:run` and the dev UI at `http://localhost:3000`.

### Running things

```bash
npm run dev          # Next.js dev server
npm run agent:run    # Run the newsletter agent once (CLI)
npm run lint         # ESLint
```

### Things to watch out for

- `fetch-emails.ts` uses `execSync` + AppleScript — macOS only. Don't add Node.js email client alternatives unless asked.
- The AppleScript writes a temp `.scpt` file and always cleans it up in `finally`. Keep that pattern.
- `data/config.json` is user data — never overwrite it with defaults or reset it without an explicit ask.
- The UI config form saves partial settings via `PATCH /api/agents/[id]` — it deep-merges `settings`, so partial updates are safe.
- Never fabricate or guess URLs in summaries — the system prompt already enforces this; don't weaken it.
