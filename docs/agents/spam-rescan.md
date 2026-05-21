---
agent: spam-rescan
source: src/agent/spam-rescan.ts
source_sha256: cbf9627aada06565bee8b6557d8885c9d881aeb62b89bfdec5aac4f1c02f610e
updated: 2026-05-19
---

# spam-rescan — false-positive-spam re-evaluation

## Purpose
Re-evaluates mail sitting in Spam/Junk and enqueues likely false positives
("probably not spam") for human review. A focused subset of the audit logic,
run on its own (weekly) cadence.

## Trigger
- CLI: `npm run mail:spam-rescan`
- HTTP: `/api/mail-analyzer/spam-rescan`
- Cron: `0 4 * * 1` (Mondays) → `/api/cron/spam-rescan`

## Inputs
- `runSpamRescan(userId?)`. Loads all messages, aggregates per sender (reuses
  [`audit`](audit.md)'s `aggregate` + `scoreFalsePositiveSpam`).

## Outputs / side-effects
- For each flagged sender, enqueues every in-Spam message into `review_queue`
  with `reason: probably_not_spam`, `suggested_action: not_spam` (dedupes).
- Returns `{ messagesScanned, sendersFlagged, messagesEnqueued }`. Read-only
  against mail; no mailbox mutation (triage/human acts on the queue).

## Dependencies
- [`audit`](audit.md) (`aggregate`, `loadAllMessages`, `scoreFalsePositiveSpam`),
  `analyzer-db` / `analyzer-db-pg`, `isMultiTenant`.

## Gotchas
- Behavior is coupled to `scoreFalsePositiveSpam` in `audit.ts` — if you change
  that scorer, re-baseline **both** specs.
- Does not start/finish a tracked run row (unlike audit/triage); it just
  returns counts.
