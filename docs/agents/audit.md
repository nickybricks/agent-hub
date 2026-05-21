---
agent: audit
source: src/agent/audit.ts
source_sha256: 970b9fe002ac84f6e678f35f7348aaf033795f6e2150a8acac10e7dad55e6887
updated: 2026-05-19
---

# audit — heuristic mailbox findings

## Purpose
Scores every sender with **pure heuristics (no LLM)** to surface five finding
kinds: `false_positive_spam`, `false_negative_inbox`, `phishing_risk`,
`hygiene_stale_sender`, `hygiene_storage_hog`. These findings feed
[`triage`](triage.md) and [`spam-rescan`](spam-rescan.md). Note: this is the
*inbox* audit — unrelated to the spec-drift "audit" in
[ARCHITECTURE.md](../../ARCHITECTURE.md).

## Trigger
- CLI: `npm run mail:audit`
- HTTP: `/api/mail-analyzer/audit` (UI)

## Inputs
- `runAudit(userId)`. Loads all messages (excluding self-sent), aggregates per
  sender (counts, spam/inbox split, read rate, size, List-Unsubscribe,
  DMARC/SPF/DKIM from stored headers).

## Outputs / side-effects
- Clears + re-inserts findings for the five kinds; records an audit run.
  Dual-path. Read-only against mail.

## Dependencies
- `analyzer-db` / `analyzer-db-pg`, `isMultiTenant`. Exports `aggregate`,
  `loadAllMessages`, `scoreFalsePositiveSpam`, `scorePhishingRisk`,
  `registrableDomain`, `tokenize` (reused by `spam-rescan` and tests —
  `src/agent/__tests__/audit.test.ts`).

## Gotchas
- Scoring is deliberately conservative: false-positive-spam needs prior
  non-spam trust **and** survives the phishing gate (Phase-2 can mislabel
  phishing as `transactional`). Tune thresholds with the test suite, not by feel.
- Brand-impersonation / suspicious-TLD / homoglyph / DMARC logic is the
  security-sensitive core — changes here should be reviewed and re-baselined
  (`npm run docs:check -- --update`) together.
- `IMAP_USER` is treated as "self" and excluded from analysis.
