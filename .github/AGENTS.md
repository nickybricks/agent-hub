# Agent team — GitHub Actions setup

The `Engineer Agent` workflow ([workflows/engineer.yml](workflows/engineer.yml))
runs the autonomous Engineer for one Notion card via `workflow_dispatch`.

## Required repo secrets

Set these under **Settings → Secrets and variables → Actions → Repository secrets**:

| Secret | Purpose |
|---|---|
| `AGENT_GH_TOKEN` | PAT used for checkout, push, and `gh pr create`. Needs `repo` scope + workflow scope. Used instead of `GITHUB_TOKEN` so the resulting PR triggers Vercel preview builds. |
| `ANTHROPIC_API_KEY` | Claude Code CLI auth. |
| `NOTION_TOKEN` | Notion integration token with read+write on the backlog DB. |
| `NOTION_BACKLOG_DB_ID` | Notion kanban database ID. |
| `TELEGRAM_BOT_TOKEN` | Bot token for status pings. |
| `TELEGRAM_CHAT_ID` | Target chat for pings. |
| `E2E_USER_EMAIL` | `e2e@mailyn.dev` (matches `.env.local`). |
| `E2E_USER_PASSWORD` | Matches `.env.local`. |
| `NEXT_PUBLIC_SUPABASE_URL` | Same as `.env.local`. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Same as `.env.local`. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role for ensure-e2e-user. |
| `DATABASE_URL` | Postgres connection string. |

## How to run

**Auto-trigger (default):** move a card to **"working on it"** in the
Notion kanban. The [`Engineer Poller`](workflows/engineer-poller.yml)
workflow runs every 5 minutes, picks the first card in that status, and
dispatches the Engineer if no run is already in flight. Telegram pings
🔵 when a dispatch fires, 🟢 on PR open, 🔴 on failure.

**Manual:** Actions → Engineer Agent → Run workflow → paste the card ID.
Useful when you want to fire one immediately or re-run a specific card.
The Engineer workflow has `concurrency: engineer-agent`, so a manual
dispatch will queue behind a running auto-dispatched one (and vice versa).

On verify failure the agent gets one retry; if it still fails the workflow
fails, Telegram gets a 🔴 ping, **and the card is moved back to Backlog**
so the poller doesn't fire it again on its next tick. Same for no-op runs
(agent exited with no changes). Re-move the card to "working on it" to
retry.

## Notes

- The card must have actionable acceptance criteria in its description.
- The workflow checks out with `fetch-depth: 0` so `git diff` against `main` works.
- Branch naming: `agent/card-<id>-<unix-ts>`.
- The agent is constrained from editing `.github/`, `playwright.config.ts`, or
  `scripts/agent/` (see [scripts/agent/engineer.ts](../scripts/agent/engineer.ts)).
- Self-verify runs `lint`, `typecheck`, `test:e2e` in that order.
