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

A Next.js 16 app (React 19, Tailwind 4, TypeScript) that fetches newsletters via IMAP, summarizes them with an LLM, and serves a digest UI.

### Architecture

- **`src/agent/`** — standalone agent scripts run via `npx tsx` or launchd
  - `fetch-emails.ts` — newsletter fetcher (uses `createMailProvider()`, parses raw RFC822 via `mailparser`)
  - `analyze-mailbox.ts` — full-mailbox scan into SQLite (`data/mail-analyzer.db`)
  - `providers/imap.ts` — generic IMAP via `imapflow` (read-only: `list`, `status`, `fetch`, `search`)
  - `providers/gmail.ts` — Gmail provider via `googleapis` (OAuth 2.0, labels as mailboxes, metadata-format fetches)
  - `providers/outlook.ts` — Microsoft Graph provider (OAuth 2.0, mailFolders, `$value` for raw MIME)
  - `summarize.ts` — LangChain factory: builds the right `BaseChatModel` from config and invokes it
  - `send-digest.ts` — sends email digest via AppleScript (last remaining AppleScript holdout; macOS-only)
  - `run.ts` — orchestrates fetch → summarize → save → (optional) send; also the CLI entry point
- **`src/app/api/`** — Next.js App Router route handlers (settings, runs, summaries, agent trigger)
- **`src/lib/`** — shared types (`types.ts`), flat-file data helpers (`data.ts`), model constants (`models.ts`)
- **`data/`** — flat-file persistence: `config.json` (agent config), `runs.json`, `summaries/YYYY-MM-DD.json`
- **`scripts/`** — shell scripts for launchd scheduling (`install-schedule.sh`, `uninstall-schedule.sh`, `run-agent.sh`)

### Key conventions

- **LLM abstraction:** all provider switching goes through `createLLM()` in `summarize.ts`. New providers → add a `case` there and a model list in `src/lib/models.ts`. Don't add provider logic elsewhere.
- **Mail provider abstraction:** all mail access goes through `createMailProvider()` in `src/lib/mail-provider.ts`. The factory reads `data/config.json` `mail.provider` (`imap` | `gmail` | `outlook`) and dynamically imports the matching `src/agent/providers/*.ts`. Don't talk to IMAP / Gmail API / Graph directly from consumers.
- **API keys:** env vars take precedence over config (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`). Config `apiKey` is a fallback. Ollama needs no key.
- **Mail credentials:** env vars override config for every provider — IMAP (`IMAP_HOST`/`IMAP_USER`/`IMAP_PASSWORD`/`IMAP_PORT`), Gmail (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REFRESH_TOKEN`), Outlook (`MS_CLIENT_ID`/`MS_CLIENT_SECRET`/`MS_TENANT_ID`/`MS_REFRESH_TOKEN`). OAuth callbacks at `/api/auth/google/callback` and `/api/auth/microsoft/callback` append the refresh token to `.env.local` via `upsertEnvVars()`.
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

- `fetch-emails.ts` talks to mail via `createMailProvider()` (read-only). For IMAP, credentials come from `.env.local` (`IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASSWORD`). For Gmail/Outlook, the OAuth refresh token is stored in `.env.local` after the user runs the Connect flow on `/settings/mail`. Never `MOVE`/`STORE`/`EXPUNGE`/`CREATE` (or the Graph/Gmail write equivalents) from this layer until Phase 3.
- **Provider quirks:**
  - **Gmail** is label-based, not folder-based. The provider treats each Gmail label as a "mailbox". The system labels (`INBOX`, `SPAM`, `TRASH`, etc.) appear alongside user labels. Gmail's "All Mail" is its own label; a single message can appear in multiple "mailboxes". Threading is via `threadId` (not exposed yet). Rate limit: 250 quota units/user/sec — metadata fetches are 5 units each, so a 500-id chunk ≈ 2500 units; we batch in groups of 20 to stay well under.
  - **Outlook** folders are hierarchical (`Inbox`, `Inbox/Subfolder`); the provider flattens them with `/`-joined paths. The closest analog to Gmail labels / IONOS folders is the `categories` field (not exposed yet). `internetMessageId` is the stable ID across providers and is what we store as `messages.id` in SQLite.
- `send-digest.ts` still uses `execSync` + AppleScript and is therefore macOS-only. It writes a temp `.scpt` file and always cleans it up in `finally` — keep that pattern, or swap to SMTP via `nodemailer` if asked.
- `data/config.json` is user data — never overwrite it with defaults or reset it without an explicit ask.
- The UI config form saves partial settings via `PATCH /api/agents/[id]` — it deep-merges `settings`, so partial updates are safe.
- Never fabricate or guess URLs in summaries — the system prompt already enforces this; don't weaken it.

---

## Git Push & Release Workflow

When asked to push to GitHub, follow this exact process:

### 1. Version Bump (Semantic Versioning)

Determine the version bump based on scope of changes:

| Change Type | Bump | Example |
|---|---|---|
| Bug fixes, typos, minor tweaks | **Patch** (`0.1.0` → `0.1.1`) | Fix a broken route or copy |
| New features, significant additions | **Minor** (`0.1.0` → `0.2.0`) | Add a new agent feature or UI section |
| Breaking changes, major rewrites | **Major** (`0.1.0` → `1.0.0`) | Complete architecture change |

- Update `"version"` in `package.json`

### 2. Never commit these files

- `data/config.json` — contains API keys and user settings
- `data/runs.json`, `data/summaries/` — runtime data
- `logs/` — log output
- `tasks/` — planning docs

### 3. Commit & Tag

```bash
# Stage only source files (never data/, logs/, tasks/)
git add next.config.ts package.json src/ scripts/ public/

# Commit with version in message
git commit -m "v{VERSION}: {brief description}"

# Create a git tag
git tag v{VERSION}
```

### 4. Push

```bash
git push origin main --tags
```

Always push tags with `--tags` so GitHub creates a release reference.
