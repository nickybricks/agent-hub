---
agent: send-digest
source: src/agent/send-digest.ts
source_sha256: d5d874124cc58d8966840fb2b06a0ecbce953992ddfca776963c59c95e111148
updated: 2026-05-19
---

# send-digest — digest email delivery

## Purpose
Delivers a rendered `Summary` as a plain-text email. The **last AppleScript
holdout** in the codebase; macOS-only.

## Trigger
Library only — called by [`run.ts`](run.md) when `deliverEmail` is set and a
recipient is configured.

## Inputs
- `summary: Summary`, `to: string`. Empty `to` → logs and returns `false`.

## Outputs / side-effects
- Sends mail via `osascript` driving Mail.app. Returns `boolean` success.
- Markdown is flattened to plain text; sources/footer appended.

## Dependencies
- `child_process.execSync`, macOS Mail.app, `langsmith/traceable`.

## Gotchas
- Writes a temp `.scpt` and **always** removes it in `finally` — keep that.
- Subject/body/recipient are escaped for AppleScript string literals; if you
  add fields, escape them too.
- 30 s `execSync` timeout. To make this cross-platform, swap to `nodemailer`
  (SMTP) — only if asked (project CLAUDE.md).
