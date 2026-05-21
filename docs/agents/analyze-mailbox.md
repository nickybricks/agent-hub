---
agent: analyze-mailbox
source: src/agent/analyze-mailbox.ts
source_sha256: 698597c0ea6220a133a51b8ca5aedec18ab9adb70b01985af3e824487c747798
updated: 2026-05-19
---

# analyze-mailbox — full mailbox scan

## Purpose
Scans every (useful) mailbox into the analyzer store — the foundation the
classify / propose / triage / audit agents all read from. Incremental via a
per-mailbox watermark.

## Trigger
- CLI: `npm run mail:analyze` (`--rescan-headers`, `--classify` to chain)
- Inngest: `mail/scan` event → chains `mail/classify`
- Cron: `0 2 * * *` → `/api/cron/scan`

## Inputs
- `runScan(userId, { rescanHeaders? })`. `userId` required iff
  `MULTI_TENANT=true` (else `DEV_USER_ID` for the CLI).
- Mail account via `createMailProvider()` (read-only).

## Outputs / side-effects
- Upserts `mailboxes` + `messages`; records scan-run progress/watermark.
- Dual-path: SQLite (`data/mail-analyzer.db`) or Postgres scoped by `userId`.

## Dependencies
- `createMailProvider`, `analyzer-db` (Sqlite) / `analyzer-db-pg` (Pg),
  `isMultiTenant`.

## Gotchas
- Skips `Drafts/Trash/Deleted/Outbox` (`SKIP_PATTERNS`).
- The provider invokes `onChunk` synchronously, so Postgres writes are
  serialized onto a `writeChain` promise and awaited after each mailbox — don't
  fire them unawaited.
- `--rescan-headers` ignores the watermark (full re-scan to backfill headers).
- `internetMessageId` is the cross-provider stable id stored as `messages.id`.
