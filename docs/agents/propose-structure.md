---
agent: propose-structure
source: src/agent/propose-structure.ts
source_sha256: 801093a74c170d8582989d358cb6a49805053012ee313e036fc082e5f165e147
updated: 2026-05-19
---

# propose-structure — folder taxonomy designer

## Purpose
Designs a small folder taxonomy (5–12 top-level, optional one-level nesting)
and the routing rules that populate it, given the full mailbox picture:
existing folders + counts + top senders, category distribution, top senders by
volume, and any synthesized user persona/preferences.

## Trigger
- CLI: `npm run mail:propose-structure` (`--provider=`, `--model=`,
  `--min-messages=`, `--limit=`)
- Inngest: `mail/propose` event (UI-driven; not cron'd)

## Inputs
- `runProposeStructure(userId, opts)`. Defaults: `minMessages=3`,
  `limit=5000` senders. Persona seam: `user_profile` + `user_pref` memories.

## Outputs / side-effects
- Clears prior **pending** proposals (accepted/applied preserved), inserts
  proposed folders + `proposed` routing rules (`source: llm_proposal`).
- Marks proposed folders that already exist as `created`.
- Writes `proposal_run` + per-folder `rule_rationale` memories. Dual-path.

## Dependencies
- `createLLM` ([summarize](summarize.md)) — **defaults to Sonnet 4.6**
  (stronger reasoner than the Haiku used for classification), `zod`,
  `prompt-safety`, `analyzer-db` / `analyzer-db-pg`.

## Gotchas
- Prompt **strongly** prefers reusing existing folder names verbatim to keep
  re-runs stable and avoid near-duplicate folders — don't weaken this.
- Output is proposals only; nothing moves mail until a human accepts a rule
  and [`triage`](triage.md) applies it.
- Re-running replaces pending proposals so a profile rebuild doesn't stack
  taxonomies.
