# mail-workflow

A macOS app that fetches AI/tech newsletters from Apple Mail, summarizes them with an LLM, and serves a daily digest UI.

**Requires macOS** — it talks to Apple Mail via AppleScript.

## How it works

1. An agent script reads newsletters from Apple Mail (by sender address or name).
2. It summarizes them using an LLM of your choice (Anthropic, OpenAI, Google, or Ollama).
3. The digest is stored locally as JSON and shown in a Next.js UI at `http://localhost:3000`.
4. Optionally, the digest is emailed to you via Apple Mail.

The agent can be triggered manually or run on a schedule via launchd.

## Setup

```bash
npm install
```

### API Keys

Set API keys as environment variables — the agent picks them up automatically. The UI also has a fallback field to store a key in `data/config.json`, but environment variables are preferred.

| Provider  | Environment variable  |
|-----------|-----------------------|
| Anthropic | `ANTHROPIC_API_KEY`   |
| OpenAI    | `OPENAI_API_KEY`      |
| Google    | `GOOGLE_API_KEY`      |
| Ollama    | *(no key needed)*     |

Add these to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.):

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-proj-..."
export GOOGLE_API_KEY="AIza..."
```

Or create a `.env.local` file in the project root (never committed):

```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-proj-...
GOOGLE_API_KEY=AIza...
```

### Optional: LangSmith tracing

All LLM calls are instrumented with [LangSmith](https://smith.langchain.com/) via `langsmith/traceable`. To enable tracing, add these variables:

```bash
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY="ls__..."
LANGCHAIN_PROJECT="mail-workflow"   # optional — groups runs in the LangSmith UI
```

Without these, the app works normally — tracing is silently skipped.

## Running

```bash
# Start the UI
npm run dev

# Run the agent once (fetch → summarize → save)
npm run agent:run

# Lint
npm run lint
```

Open [http://localhost:3000](http://localhost:3000) to see the digest UI and configure the agent.

## Scheduling (launchd)

To run the agent automatically on a schedule, use the included scripts:

```bash
# Install the launchd job (uses the schedule configured in the UI)
./scripts/install-schedule.sh

# Remove it
./scripts/uninstall-schedule.sh
```

## Configuration

All agent settings are stored in `data/config.json` and editable via the Settings tab in the UI:

- **Senders** — email addresses or sender names to monitor
- **Lookback window** — how many hours back to fetch emails
- **Max emails per run** — cap on emails processed in one run
- **Output language** — language the digest is written in
- **LLM provider + model** — which AI to use
- **System prompt** — instructions for the LLM
- **Schedule** — when to run automatically
- **Email delivery** — optionally send the digest via Apple Mail

> `data/config.json` contains user settings and should not be committed. Add it to `.gitignore` if you fork this repo.

## Data

All data is stored as flat JSON files — no database required:

| Path | Contents |
|------|----------|
| `data/config.json` | Agent configuration |
| `data/runs.json` | Last 50 agent run records |
| `data/summaries/YYYY-MM-DD.json` | Daily digest summaries |
| `data/debug/` | Full debug snapshots (prompt + response) per run |
