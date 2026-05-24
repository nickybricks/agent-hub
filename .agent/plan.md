# Plan

## In plain English (no jargon)
Right now, once the app accepts a folder proposal, the user has no place in the app to see "what does my mailbox actually look like now?" The Home tab shows overall numbers, Proposals shows what's *pending*, Audit and History show problems and past actions — but the day-to-day folder structure itself is invisible.

This change adds a new **Folders** tab between Home and Proposals. It lists every folder in the user's mailbox as a tree (top-level folders with their sub-folders nested underneath), showing for each one how many messages it holds and who the top senders are. Clicking a folder opens a popup that shows the routing rules that send mail there — and the user can tweak, turn on/off, delete, or add rules right inside that popup. Rules are saved straight to our database; the actual mailbox folders are not renamed/created/deleted (that comes later in Phase 3).

## My interpretation of the card
The card is explicit:
- New tab between **Home** and **Proposals**.
- Tree of current mailbox folders (from the `mailboxes` table — what already exists in the user's account), grouped by splitting names on `/`. Top-level rows; sub-rows revealed by accordion.
- Per row: name, message count, short summary (top senders + top categories).
- Click a row → modal with: rules whose `target_folder` matches this folder + sample subjects per rule.
- Inside the modal: inline edit (match_value, target_folder, confidence), toggle accepted ↔ rejected (active ↔ inactive), delete the rule, add a new rule. All Postgres-only via `folder_rules`.
- Folder-level write actions (rename / delete / create the actual mailbox folder) are **disabled with a "coming once folder writes are wired" tooltip**.
- Empty state: "Accept a proposal to start building your structure."
- "Phase-3 detail: accepted proposals should move out of Proposals tab onto this Folders tab" — I read this as a forward-looking note about the eventual destination, **not** an authorization to remove proposals from the Proposals pane right now. The Proposals pane today filters/lists by `proposed_folders.status`; touching that is out of scope.

Conservative reads:
- I will not delete rule rows; I will treat the `status` field as the canonical active/inactive switch (accepted = active, rejected = inactive). For "delete rule", the card lists it as a separate action from "toggle active/inactive" — so I'll add a DELETE endpoint that actually removes the row. Both LLM-proposed and user-added rules can be removed.
- The "edit confidence" affordance — confidence is a number the LLM sets; user-editable confidence is an unusual UX choice. The card lists it explicitly, so I'll wire it (number input in the rule editor) and let the user set it to `null` by clearing the field. No revalidation magic — it's just stored.
- "Top categories" per folder: I'll derive from `senders.category` joined to the messages in that mailbox (top 3 by message count). New small read helper.

## My approach
1. **DB helpers** (`src/lib/analyzer-db-pg.ts`):
   - Add `listFolderTreePg(userId)` — returns `[{ id, name, msg_count, top_senders, top_categories }]` for every mailbox. Uses the existing pattern (Drizzle `db.execute(sql\`...\`)`).
   - Add `getRulesForFolderPg(userId, folderName)` — returns the rules whose `target_folder = folderName`, regardless of `status` / `source`. (The proposals route filters `source = 'llm_proposal'`; here I want all rules, including user-added ones.)
   - Add `getSampleSubjectsForRulePg(userId, ruleId)` — up to 5 sample subjects from messages matching the rule's `match_type` + `match_value`. Mirrors the existing `getMessagesMatchingRulePg` shape but trimmed.
   - Add `deleteFolderRulePg(userId, ruleId)` — `DELETE FROM folder_rules WHERE id = ... AND user_id = ...`.
   - Extend `updateFolderRuleMatchPg` (or add a sibling) to also handle `confidence`. Conservative path: extend the existing one to accept an optional confidence and a tri-state target ("set/keep/null"). Keep existing callers unaffected.
2. **API routes** (Next.js App Router, mirror existing patterns):
   - `GET /api/mail-analyzer/folders` → list tree (folders + counts + top senders + top categories).
   - `GET /api/mail-analyzer/folders/[name]` → details for one folder (rules + sample subjects). Name is URL-encoded.
   - `POST /api/mail-analyzer/folders/[name]/rules` → add a new rule (source `user`, status `accepted`).
   - `DELETE /api/mail-analyzer/proposals/rule/[id]` → add DELETE handler to the existing route file (the file already does PATCH; adding DELETE keeps the surface unified).
   - Extend the existing PATCH on `/api/mail-analyzer/proposals/rule/[id]` to also accept `confidence`.
   - All routes call `getAuthUser()` and bail on missing auth, per `docs/PATTERNS.md`.
3. **Pane component** (`src/components/panes/FoldersPane.tsx`, new):
   - Mirror the structure of `ProposalsPane.tsx` (header + body + cards).
   - Loading / empty states. Empty copy: "Accept a proposal to start building your structure." (real copy, not "No data" — per PATTERNS).
   - Tree: group rows by first path segment; an expand/collapse caret reveals nested rows. Indent sub-rows by one level. Multi-level paths (`a/b/c`) collapse into a flat two-level view (top + everything under it) — keeps the UI calm. Only one level of nesting is exposed; deeper paths render with their full sub-path string in the sub-row label.
   - Row content: name, message count (tabular nums), one-line summary line: "top: foo@x.com, bar@y.com · newsletter, marketing".
   - Clicking a row opens an inline modal (re-use the dimmed-overlay + dialog pattern from `SettingsModal.tsx`).
   - Modal content: folder name (title), disabled "Rename folder" / "Delete folder" / "New subfolder" buttons with `title="Coming once folder writes are wired."` tooltip; the rules list; an "Add rule" footer.
   - Each rule row in the modal: editable match_value text input, target_folder text input, confidence number input (blank → null), match_type dropdown (sender_email | sender_domain), active toggle, delete button, sample-subjects collapsible.
   - "Add rule" form: same inputs, "Add" button calls POST; defaults: match_type = sender_domain, target_folder = current folder, status = accepted, source = user.
   - `useRevalidate(active, load)` plumbing like every other pane.
4. **Tabs array** (`src/app/app/page.tsx`): add `"Folders"` between `"Home"` and `"Proposals"`. Add the pane to the `pane` record.
5. Manual / e2e check at the end.

## Files I expect to touch
- `src/lib/analyzer-db-pg.ts` — add 4 new helpers (+ extend one).
- `src/app/api/mail-analyzer/folders/route.ts` — new (list).
- `src/app/api/mail-analyzer/folders/[name]/route.ts` — new (detail).
- `src/app/api/mail-analyzer/folders/[name]/rules/route.ts` — new (POST add rule).
- `src/app/api/mail-analyzer/proposals/rule/[id]/route.ts` — extend (DELETE + confidence in PATCH).
- `src/components/panes/FoldersPane.tsx` — new.
- `src/app/app/page.tsx` — add to TABS array + import.

## Explicitly out of scope
- **No mailbox-write logic** — no rename, delete, or create-folder against the user's mail provider. Phase 3.
- **Not moving accepted proposals off the Proposals tab.** The card's phase-3 sentence describes the eventual destination; I'm not removing the proposals pane's display of accepted/created folders, and I'm not touching `src/components/panes/ProposalsPane.tsx`.
- **Not changing `getProposalsWithRulesPg` or any proposals-side route** — those keep working as is.
- **No drag-and-drop** for rules between folders. The Proposals tab already has that; the card didn't ask for it here, and "click → modal → edit target_folder" already covers reassignment.
- **No category re-derivation** — top categories per folder uses existing `senders.category` rows. If a folder is full of unclassified senders, the summary line will say "unclassified".
- **No bulk actions** ("Accept all" / "Apply all") at the folder level — the card asks for per-rule editing only.
- **Not touching `docs/`, `tasks/`, `.github/`, `package.json` version, or any of the prompt's "do not touch" list.**

## Open questions / assumptions
- Assuming "current mailbox structure" = rows in the `mailboxes` table (the user's *actual* folders as last scanned). Not `proposed_folders` (that's the proposal staging area).
- Assuming the modal should list rules **across all statuses and sources**, not just `proposed` + `llm_proposal`. The card describes the modal as showing "rules routing mail here" — a user-added rule routes mail to that folder too, so it belongs in the list.
- Assuming the tree's "nesting" is the simple single-level split that exists today in `mailboxes.name` (`Inbox/Promotions`, `Inbox/Travel/Flights`). I'll group by first segment; anything beyond becomes the sub-row label as-is. A deeper tree wasn't asked for, would balloon the design, and the source data is flat strings.
- Assuming the disabled folder-level buttons (rename / delete / new subfolder) are sufficient to surface the Phase-3 gap. The PRODUCT.md north-star says "show disabled with a 'coming once folder writes are wired' tooltip — don't hide the gap."
- Assuming **the `getProposalFolderRowsPg` name** in the card refers to the existing helper that pulls mailboxes-with-counts. The name is misleading (it's about *mailboxes*, not *proposals*), but it's the one cited in the card.
- Assuming sample subjects come from un-moved messages (consistent with `getMessagesMatchingRulePg`); the goal is to show the user what would route, not historical movement.
- I will **not** add a "confidence" editor inside the inline modal if it adds clutter without value — but the card lists it, so it goes in, with a small label.
