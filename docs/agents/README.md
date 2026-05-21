# Agent specs

One spec per agent script in [`src/agent/`](../../src/agent/). Each describes
the agent's **purpose, trigger, inputs, outputs/side-effects, dependencies, and
gotchas**. For how the agents fit together, see
[ARCHITECTURE.md](../../ARCHITECTURE.md).

| Spec | Source | What it does |
|---|---|---|
| [run](run.md) | `src/agent/run.ts` | Orchestrates the newsletter digest pipeline |
| [fetch-emails](fetch-emails.md) | `src/agent/fetch-emails.ts` | Pulls newsletter mail, parses RFC822, extracts links/images |
| [summarize](summarize.md) | `src/agent/summarize.ts` | LLM factory + structured digest generation |
| [send-digest](send-digest.md) | `src/agent/send-digest.ts` | Emails the rendered digest (AppleScript, macOS) |
| [analyze-mailbox](analyze-mailbox.md) | `src/agent/analyze-mailbox.ts` | Full mailbox scan into the analyzer store |
| [classify-senders](classify-senders.md) | `src/agent/classify-senders.ts` | LLM categorizes senders in batches |
| [propose-structure](propose-structure.md) | `src/agent/propose-structure.ts` | LLM designs a folder taxonomy + routing rules |
| [triage](triage.md) | `src/agent/triage.ts` | Applies rules: auto-moves mail or queues for review |
| [audit](audit.md) | `src/agent/audit.ts` | Heuristic spam/phishing/hygiene findings (no LLM) |
| [spam-rescan](spam-rescan.md) | `src/agent/spam-rescan.ts` | Re-flags false-positive spam into the review queue |

**Keeping these honest:** frontmatter pins each source file's SHA-256.
`npm run docs:check` fails if code changed without the spec being re-baselined.
After updating a spec's prose to match a code change, run
`npm run docs:check -- --update`.
