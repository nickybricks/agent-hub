---
agent: triage
source: src/agent/triage.ts
source_sha256: 60da3aa438f4a8ad985b37d0b0054ac4e8891dc80b34c35a57f0876789c33d96
updated: 2026-05-19
---

# triage — rule application & review queue

## Purpose
The **only agent that writes to the mail account.** For each new message it
either auto-moves it (an accepted rule matched) or enqueues a review item for
the human. Combines accepted routing rules with audit findings
(false-positive-spam / false-negative-inbox).

## Trigger
- CLI: `npm run mail:triage` (`--dry-run`)
- Inngest: `mail/triage` event
- Cron: `30 2 * * *` → `/api/cron/triage`

## Inputs
- `runTriage(userId, { dryRun? })`. Candidates since the last triage
  watermark, capped at `TRIAGE_BATCH_LIMIT` (default 500).
- Reads accepted/proposed `folder_rules` and audit findings.

## Outputs / side-effects
- **Auto-move:** only for `accepted` `route_to` rules → provider
  `createMailbox` + `moveMessages`; logs every move (applied/failed), updates
  `messages.mailbox_id`, touches the rule, writes an `apply_action` memory.
- **Review queue:** proposed rules, audit-flagged spam mismatches,
  low-confidence / unknown senders → `review_queue` (no mail mutation).
- Records triage-run counts + advances the watermark.

## Dependencies
- `createMailProvider` (**write path**), `analyzer-db` / `analyzer-db-pg`,
  credentials helper (MT) / `readMailConfig` (single-user).

## Gotchas
- `--dry-run` prints the plan and mutates nothing (no run row either).
- Moves are grouped by `from→to` pair and applied per group; only ids the
  provider reports `ok` get their DB mailbox/rule/memory updated.
- This is the agent to scrutinize for safety — never broaden it to move mail
  for `proposed` (un-accepted) rules.
