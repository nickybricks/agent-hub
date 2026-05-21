---
agent: fetch-emails
source: src/agent/fetch-emails.ts
source_sha256: 175eb554585c3b630935b64b0e7f239c16d7133996e45a6315a60690a5e61c6a
updated: 2026-05-19
---

# fetch-emails — newsletter fetcher & parser

## Purpose
Fetches recent messages from the configured senders and parses raw RFC822 into
the app's `Email` shape, extracting clean links and content images and
inserting `[IMAGE_N]` position markers so the LLM can place images in context.

## Trigger
Library only — called by [`run.ts`](run.md) via `fetchNewsletterEmails(...)`.
No CLI entry point.

## Inputs
- `senders: string[]`, `lookbackHours: number`, `maxEmails: number`.
- Mail account via `createMailProvider()` (credentials from `.env.local`/config).

## Outputs / side-effects
- Returns `Email[]` (deduped by message-id). **Read-only** against mail —
  `list` / `status` / `fetch` / `search` only.

## Dependencies
- `createMailProvider()`, `mailparser` (`simpleParser`), `langsmith/traceable`.

## Behavior notes
- Skips Drafts/Trash/Sent/Outbox-type mailboxes (`SKIP_MAILBOX`, EN+DE).
- Strips tracking/unsubscribe/social-share URLs and 1×1 pixel images
  (`SKIP_URL`); caps 50 links / 30 images per mail.
- Plaintext body truncated to 10 000 chars before marker insertion.
- `parseRawEmail` is exported and reused (e.g. tests); `isRead` is set by the
  caller from provider flags, not the parser.

## Gotchas
- Image markers are evenly spaced across paragraph breaks; if there's only one
  paragraph they're appended at the end.
- Dedup is by `Message-ID` with a `box:uid` fallback — a mail with no
  Message-ID seen in two mailboxes can appear twice only if the fallback differs.
