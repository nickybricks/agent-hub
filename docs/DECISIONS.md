# Decisions log

Append-only. Newest at top. Each entry: **context → options considered → choice → why → rejected and why-not**.

When the agent has to make a new judgment call mid-task, it appends an entry here as part of the PR. When in doubt about whether something has been decided, search this file first.

---

## 2026-05-24 — Persona updates auto-apply (no confirm card)

- **Context:** `update_persona` was a `kind: "mutate"` chat tool, so correcting a fact in chat ("actually I'm a designer") produced an Apply/Cancel card the user had to click before the persona memory updated. Every other persona surface (Profile tab inline edit, onboarding persona-confirm card) already gives the user direct control; the in-chat confirm doubled the friction without adding safety.
- **Choice:** Switched `update_persona` to `kind: "read"` so the chat loop auto-executes it like `save_onboarding_answer`. The write still goes through the same `user_profile` memory + `supersedeMemoryPg` superseding chain — only the gating changed. Profile-tab refresh still rides the existing `bump()` → `useRevalidate` path.
- **Why:** Persona is a paragraph of self-description, not a mailbox-modifying action. Mistakes are visible, scoped to one user, and instantly re-correctable in the same chat ("actually no, make it a designer"). The confirm card created the worst kind of friction: it interrupted the conversational repair loop the user was already in.
- **Rejected:**
  - *Keep the confirm but auto-click after N seconds* — fragile UX, the user still sees a flash of card.
  - *Introduce a new `kind: "mutate_auto"` literal* — single-use abstraction; PATTERNS.md's "Anti-patterns" calls these out. `save_onboarding_answer` already shows the precedent for "write-but-auto-runs" lives under `kind: "read"`.
  - *Make all mutate tools auto-apply* — out of scope and dangerous. Folder/rule/audit actions touch the user's actual mailbox via the provider; persona only writes one row of agent memory.
- **Scope guard:** every other mutating tool (`rename_proposed_folder`, `set_proposed_folder_status`, `set_rule_status`, `update_rule_match`, `apply_rule`, `dismiss_audit_finding`, `set_audit_override`, `clear_pending_proposals`, `trigger_propose_structure`, `add_proposed_folder`, `write_memory`) keeps its `kind: "mutate"` and its Apply/Cancel card.
- **Doc drift to fix later:** `docs/PATTERNS.md` "Memory system" section calls `update_persona` a mutate tool. That line is now stale.

## 2026-05-21 — Landing page at `/`, waitlist via Supabase

- **Context:** App was `/app`-only; anonymous visitors got a redirect. Pre-launch needed a real top-of-funnel.
- **Choice:** Hero-only landing page at `/`. Waitlist form posts to `/api/waitlist` → service-role insert into a `waitlist` table. Sidebar suppressed on `/`. Signed-in users still redirect to `/app`.
- **Why:** Lowest-effort path to a shareable URL with email capture. Service-role insert avoids RLS plumbing for a single-purpose anonymous write.
- **Rejected:** A marketing site in a separate repo (premature), an embedded form provider (loses control of styling/data).

## 2026-05-21 — `folder_strategy` replaces abstract `folder_style` in onboarding

- **Context:** "What folder style do you prefer?" was abstract and produced generic answers; propose-structure was also muzzled with "STRONGLY prefer reusing verbatim" which suppressed any actual restructuring.
- **Choice:** Concrete three-way question — `keep_augment` / `simplify` / `fresh_start` — shown with the user's real folder count + sample names. Propose-structure adapts its system prompt to the saved strategy; the verbatim-reuse muzzle is dropped.
- **Why:** Concrete options anchored in the user's own mailbox produce decisions the user actually owns. Removing the muzzle is what lets `simplify`/`fresh_start` work at all.
- **Rejected:** Keeping the muzzle (made `fresh_start` impossible). Asking later in chat (onboarding is where the user is most engaged).

## 2026-05-20 — Single-path Postgres; SQLite removed

- **Context:** Codebase had dual-path SQLite + Postgres branching (`isMultiTenant()`, `MULTI_TENANT` env, parallel `*-pg.ts` helpers) across ~50 files.
- **Choice:** Postgres only. Supabase in prod, local Postgres / dev Supabase for local. SQLite implementation, `isMultiTenant()`, and `MULTI_TENANT` env removed. ~1500 lines deleted.
- **Why:** Prod is Supabase; SQLite branch was never the product and was carrying weight it didn't need to.
- **Rejected:** Keeping dual-path "for offline dev" — local Postgres works fine.
- **Supersedes:** prior `feedback-dual-path-storage` memory that said "ship dual-path for new tables." That guidance is dead. **New tables: Drizzle + PG only.**

## 2026-05-20 — Chat is Sonnet-only (no router yet)

- **Context:** Every chat turn goes to Sonnet 4.6 at ~4–5¢ per interaction. A `chat-llm-router` design exists.
- **Choice:** Keep Sonnet-only until real-user load justifies the router. Log cost in LangSmith. Add per-user budget before opening signups.
- **Why:** Premature optimization. Pre-real-users the absolute spend is negligible; correctness of the chat experience matters more than 10× cost.
- **Rejected:** Building the router now — risks regressing chat quality without a measurable cost problem yet.
- **Trigger to revisit:** real users signing up, or chat-turn frequency increasing (e.g. proactive prompts).

## 2026-05-20 — Stream the proposal taxonomy call

- **Context:** Sonnet folder-taxonomy inference takes 1–3 min on a real mailbox; users stared at a static spinner.
- **Choice:** `llm.bindTools(...).stream()` + depth-aware `FolderStreamParser` yielding completed folder JSON objects live. Pipeline `done` gates on a `proposal_run` memory marker, *not* on `proposals.length > 0`.
- **Why:** ~80% of the perceived-progress win at 0% extra token cost. Same prompt, same model.
- **Rejected:** Two-pass split (folder design + parallel rule gen) — ~3× cost, marginal wall-time win, only worth it at 5–10k+ senders. Logged as deferred.

## 2026-05-18 — Settings modal: single Account panel

- **Context:** Five tabs (Profile/Privacy/Notifications/Documents/Account) drafted from screenshots of a different product.
- **Choice:** Single Account panel — read-only email, sign out, delete account (typed-DELETE confirm). Built and deleted: profile/avatar backend, OTP email, `user_profiles` + `email_verifications` tables.
- **Why:** No consumer for name/avatar, no per-user notification system, Privacy/Documents undefined. Speculative surface.
- **Rejected:** Building all five tabs — would have to be deleted later.
- **Lesson:** Screenshots from a different product are not requirements. Push back on speculative tabs early.

## 2026-05-18 — Prod environment config quartet (Inngest / auth / DB)

Four prod-only fixes that all looked like app bugs but were environment config. Future agents must not "fix" these in app code:

1. **Inngest:** `new Inngest({ id, isDev: process.env.INNGEST_DEV === "1" })`. Explicit, never auto-detect. `INNGEST_DEV=1` is **local only**.
2. **Auth callback:** handle BOTH PKCE `?code` *and* token-hash `?token_hash&type` flows. Magic links use token-hash.
3. **Auth cookies:** set on the *returned* `NextResponse` object, not via `next/headers`. Canonical Supabase-SSR route-handler pattern.
4. **Database URL:** prod uses the **Supabase session pooler** (`postgres.<ref>@aws-0-<region>.pooler.supabase.com:5432`), never the direct `db.<ref>` host (IPv6-only, Vercel can't reach it). `postgres(url, { prepare: false, max: 1, idle_timeout: 20 })` — `prepare: false` is mandatory behind pgbouncer.

If something looks broken in prod and works locally, suspect env config before app code.

## 2026-05-17 — Persona-driven onboarding (replaces silent scan)

- **Context:** Old onboarding was "connect → silent scan → dashboard." Propose-structure was generic — couldn't tell "stripe.com = I run a business" from "bought one thing once."
- **Choice:** Short questionnaire → scan+classify → Sonnet synthesizes narrative persona → user reviews/edits → saved as memory → propose-structure reads it.
- **Why:** Personalized taxonomy needs context the senders alone don't provide. Show-and-confirm keeps the user in control.
- **Rejected:** Auto-saving persona without confirm (loss of control), new parallel agent for persona (over-engineering; memory injection is enough).

## 2026-05-17 — `/app` shell is calm overview, not data dump

- **Context:** First-cut tabs wrapped the old full-page routes (`max-w-[1400px]`, heavy scroll, sub-tabs).
- **Choice:** Pane-native components, one-screen density, progressive disclosure, inline + drag-and-drop actions, chat panel as escape hatch.
- **Why:** Users come for calm, not for another dashboard.
- **Rejected:** Keeping the wrapped pages "until we have time" — that's how placeholders become permanent.
