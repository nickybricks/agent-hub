# Decisions

## In plain English (no jargon)
The app now has a new **Folders** tab — sitting between Home and Proposals — that shows the user the structure of their mailbox as it stands today. Each folder is one row with a message count, the top senders inside it, and the top categories of those senders. Folders with sub-folders open out via a small arrow so the user can drill in. Clicking any folder opens a popup that lists the routing rules pointing at it; inside the popup the user can edit a rule's match value, target, confidence and active state, delete it, or add a new one. The actual mailbox folders are not renamed, deleted, or created from this tab — those buttons appear greyed out with a tooltip noting they'll work once "folder writes" (the upcoming Phase-3 mail-write feature) ship.

## What changed
- `src/lib/analyzer-db-pg.ts` — added four new read/write helpers (`listFolderTreePg`, `getRulesForFolderPg`, `getSampleSubjectsForRulePg`, `deleteFolderRulePg`) and one extension (`updateFolderRuleConfidencePg`). All Drizzle + Postgres, all `user_id`-scoped, no schema change.
- `src/app/api/mail-analyzer/folders/route.ts` — new `GET` for the tree view (folder + msg count + top senders + top categories).
- `src/app/api/mail-analyzer/folders/[name]/route.ts` — new `GET` for the modal: rules pointing at the folder, each enriched with up to 5 sample subjects.
- `src/app/api/mail-analyzer/folders/[name]/rules/route.ts` — new `POST` to add a user-authored rule for the folder (`source = 'user'`, `status = 'accepted'`).
- `src/app/api/mail-analyzer/proposals/rule/[id]/route.ts` — extended `PATCH` to accept `confidence`; added a `DELETE` handler so rules can be physically removed.
- `src/components/panes/FoldersPane.tsx` — new pane. Tree (one accordion level), modal with inline rule editor + add form, disabled folder-write buttons with the Phase-3 tooltip.
- `src/app/app/page.tsx` — added `"Folders"` between `"Home"` and `"Proposals"` in `TABS`, imported the pane, wired it into the `pane` record.

## Why these choices
- **One pass for the tree, not N+1.** `listFolderTreePg` runs three grouped queries (folders, top-3 senders per mailbox, top-3 categories per mailbox) and stitches them in JS. Mirrors the batching note in `PATTERNS.md` and the comment near `getRulePendingCountsPg` in `analyzer-db-pg.ts`, which already used the same shape.
- **Rules for the modal include user-added ones.** `getRulesForFolderPg` does NOT filter by `source = 'llm_proposal'` (unlike `getProposalsWithRulesPg`, which feeds the Proposals tab). The card's scope is "rules routing mail here" — a user-added rule routes mail too, so it belongs.
- **Reusing `/api/mail-analyzer/proposals/rule/[id]` for PATCH + DELETE** instead of creating a new `/api/mail-analyzer/folders/.../rules/[id]`. The id is globally unique within `folder_rules`, and the existing route already PATCHes status / match / target — staying inside it kept the rule-mutation API surface in one place. Alternative considered: a dedicated `folders/.../rules/[id]` route — clearer URL semantics but duplicates the existing logic. Rejected: small win, large duplication.
- **`status` is the active/inactive switch** (accepted ↔ rejected). The card's "toggle active/inactive" maps cleanly onto the existing enum — no new schema field needed.
- **Synthetic parent rows** for path prefixes that aren't themselves real mailboxes. Outlook hierarchies like `Inbox/Travel/Flights` appear in `mailboxes.name` as a single flat string; if `Inbox/Travel` doesn't exist on its own but `Inbox/Travel/Flights` does, the UI still wants a parent header. Implemented as derived display-only rows (not clickable into the modal, since no rules can target a non-existent folder).
- **`source: "user"` + `status: "accepted"` for added rules.** The user is creating an active rule by hand; no proposal step needed. Mirrors the `add_proposed_folder` chat tool's pattern for proposed rules, but with the user-authored source.
- **`writeMemoryPg` on add/delete/status changes** — matches the existing PATCH handler, which already writes a `user_decision` memory line for every rule status change. Stays consistent with `PATTERNS.md` "memory system" section.
- **Disabled folder-write buttons with tooltip**, not hidden. `PRODUCT.md` north-star #5: "show disabled with a 'coming once folder writes are wired' tooltip — don't hide the gap."

## Judgment calls I made
- **Confidence editor**: card lists it explicitly. I wired a number input (0–1, step 0.01). Empty → null. I'm honestly not sure how often a human will adjust a confidence — it could mostly stay untouched. Reviewer should sanity-check the UX before assuming it earns its space.
- **Tree depth = one level**: I split only on the first `/`. Deeper paths (`Inbox/Travel/Flights`) render as full-path strings in the sub-row. Going recursive would be a different UX choice and not what the card asked for ("top-level folders + accordion for subfolders"). If the reviewer wants true recursive nesting, that's a follow-up.
- **Sample subjects = 5, sorted by recency**: arbitrary cutoff. Card just said "sample subjects" without a number.
- **Rule deletion confirms via the browser's `confirm()` dialog**, like ProposalsPane already does for bulk actions. A custom-styled confirmation modal would be nicer but is out of scope.
- **Empty state copy**: "Accept a proposal to start building your structure." — used the card's verbatim suggestion.
- **Folder-detail GET runs one sample query per rule** (`Promise.all` over rules). I judged this fine because a folder usually has <10 rules; if a folder gets pathological, this can be batched the same way `getRulePendingCountsPg` does. Flagging it because the reviewer should know.
- **Saving rule edits is not optimistic**: each save does a `PATCH → reload` round-trip. Avoids drift between local form state and DB. The tradeoff is a small flicker on save.
- **No `useEffect` resync of form state in `RuleEditor`.** ESLint's `set-state-in-effect` rule rejected the naive resync. After save, the local values already match the server response, so "dirty" naturally becomes false; the editor is keyed by rule id, so a rule-list change remounts it cleanly.

## What I deliberately did NOT do
- **Did not touch `ProposalsPane.tsx` or its data.** The card's last sentence about "accepted proposals moving onto this Folders tab" describes a Phase-3 destination, not a now-removal of the proposals view. Leaving the existing pane untouched is the safe read.
- **No mail-provider writes.** No IMAP `CREATE` / Gmail label create / Graph folder POST. No code path on this tab can touch the user's account.
- **No drag-and-drop** between folders inside the modal. Proposals tab has DnD for re-targeting; the card here asked for "edit rule target" via the editor inputs, which is what's there.
- **No bulk actions** at the folder level. The card asked for per-rule editing, not "accept all rules under folder X".
- **Did not touch CLAUDE.md, docs/, tasks/, .github/, scripts/agent/, playwright.config.ts, or version numbers.** Per the prompt's hard rules.
- **No new e2e tests.** Existing 3 pass; adding a Folders golden path would require a fixture mailbox with `mailboxes` and `folder_rules` data, which is broader than the card's "DB-only view" scope.

## Risks and follow-ups
- **N+1 inside the modal detail endpoint** (one sample-subjects query per rule). Acceptable for normal folder sizes (<10 rules); promote to a single grouped query if a folder grows huge.
- **Synthetic parent rows aren't clickable.** They're display-only — clicking does nothing. A user might expect to click "Inbox" (when only `Inbox/Promotions` exists as a real mailbox) and see something. Currently they get no feedback. Could be a follow-up "click → show aggregated rules from children" view.
- **No keyboard navigation in the tree.** Mouse-only. Accessibility follow-up if needed.
- **The `getProposalFolderRowsPg` name is misleading** (it returns mailboxes, not proposals). The card cites it correctly; the existing helper stays — but it earns a rename in a cleanup pass.
- **Reviewer to sanity-check confidence-edit UX.** Numeric 0–1 inputs are easy to misuse; if real users find it confusing, drop it back to read-only and surface a hint instead.
- **No update to `DECISIONS.md`.** The prompt's hard rules forbid touching mandatory-reading docs; no new judgment here that contradicts an existing decision.
