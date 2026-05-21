---
agent: classify-senders
source: src/agent/classify-senders.ts
source_sha256: 8193b9b300e9aa66749133b24b4f11f485d31225bd7be3cf5a25764a28485b3e
updated: 2026-05-19
---

# classify-senders — LLM sender categorization

## Purpose
Assigns every unclassified sender one of the `SENDER_CATEGORIES`
(newsletter, transactional, personal, promotional, notification, social,
work, other) using domain, display name, and recent subjects as evidence.
Feeds `propose-structure` and `triage`.

## Trigger
- CLI: `npm run mail:classify` (`--limit=`, `--min-messages=`,
  `--provider=`, `--model=`, `--concurrency=`)
- Inngest: `mail/classify` event (chained from `mail/scan`)
- Cron: `0 3 * * *` → `/api/cron/classify`

## Inputs
- `runClassify(userId, opts)`. Senders pulled from the analyzer store
  (`getUnclassifiedSenders`), batched in groups of `BATCH_SIZE = 20`.
- LLM config: `data/config.json` in single-user; in MT (or if missing) derives
  a cheap model from env keys (`gpt-4o-mini` / `claude-haiku-4-5`).

## Outputs / side-effects
- Writes `senders.category` (+ classifying model) per sender. Dual-path.

## Dependencies
- `createLLM` ([summarize](summarize.md)), `zod` structured output,
  `prompt-safety`, `analyzer-db` / `analyzer-db-pg`.

## Gotchas
- Bulk task → intentionally a **cheap** model (Haiku / 4o-mini), not the
  digest model.
- 6 concurrent workers over the batch list by default; a failed batch is
  counted (`batchErrors`) and skipped, not retried — those senders stay
  unclassified for the next run.
- Senders missing from the LLM response default to `other`.
- System prompt is wrapped with `withGuardrail`; subjects `sanitizeSubject`'d.
