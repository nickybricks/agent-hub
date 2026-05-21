# Patterns — how we do things here

Concrete, repeatable patterns. If you're about to write code that touches one of these areas, follow the pattern. If you're tempted to deviate, justify it in the PR description.

---

## Data layer

- **Postgres only.** No SQLite, no dual-path, no `isMultiTenant()`. New tables: Drizzle schema in `db/schema.ts` + a `*Pg.ts` helper module.
- **Naming:** helpers currently end in `Pg` (e.g. `getProposalFolderRowsPg`). Cleanup to drop the suffix is pending; until then, follow the existing convention.
- **Auth:** every route handler calls `getAuthUser()` once and treats `userId` as a non-null `string`. Don't reach for `LOCAL_USER` directly.
- **Background scripts** read `DEV_USER_ID` from env.
- **Postgres client config (prod-critical):** `postgres(url, { prepare: false, max: 1, idle_timeout: 20 })`. `prepare: false` is mandatory behind the Supabase pgbouncer pooler. Don't "optimize" it away.

## Mail provider access

- All mail access goes through `createMailProvider()` in `src/lib/mail-provider.ts`. The factory dispatches to `src/agent/providers/{imap,gmail,outlook}.ts` based on `mail.provider` in config.
- **Read-only until Phase 3.** No `MOVE` / `STORE` / `EXPUNGE` / `CREATE` (IMAP) or the Graph/Gmail write equivalents from any consumer.
- **Provider quirks** are documented in CLAUDE.md — Gmail is label-based, Outlook is folder-hierarchy, IMAP is folder-tree. Use `internetMessageId` as the stable cross-provider ID.

## LLM calls

- All provider switching goes through `createLLM()` in `src/agent/summarize.ts`. New provider → add a `case` there + a model list in `src/lib/models.ts`. No provider-specific imports outside that factory.
- **Default:** Anthropic Sonnet 4.6 for any chat or proposal call. Haiku 4.5 is the cheap fallback (10× less) but the router is not built yet.
- **Persona injection:** any LLM call that produces user-visible output must read the persona memory and inject it. The current seam: `chat-agent.ts` and `propose-structure.ts` both call `listMemories`. If you add a third user-facing LLM call, do the same.
- **Streaming:** for long calls (taxonomy, persona synth), use `bindTools(...).stream()` + a parser that yields complete objects. Don't show a static spinner for >5s of work.

## Loading and progress UX

- **Honest copy.** "Drafting your profile · Usually 5–30 seconds" beats "Loading…". Name what's running.
- **Live progress** where available — folder count rising during proposal stream, elapsed timer.
- **Defensive polling:** if a "ready" signal hasn't flipped after 5s past the expected completion, refetch once before giving up.
- **Don't gate "done" on derived counts** (e.g. `proposals.length > 0` — the first insert would falsely end the loading view). Gate on an explicit terminal marker (`proposal_run` memory).

## Memory system

- One memory per concept. Don't add a second one that overlaps. (Cautionary tale: `soul` + `user_profile` ended up disagreeing — see kickoff item 2.)
- **Kinds:** `system` (machine-written context), `user_pref` (questionnaire answers), `soul` (user-volunteered facts), `user_profile` (synthesized persona).
- **Mutate tools** explicitly: `update_persona` *replaces*, `remember_about_user` *appends*. Don't mix semantics.
- A memory in your `~/.claude/` is *your* memory, not the repo's. If it should guide an autonomous agent, write it into `DECISIONS.md` or here.

## Pane / UI architecture

- One tab = one pane component in `src/components/panes/`. Imported into `src/app/app/page.tsx` via the `TABS` array.
- **One-screen density.** No `max-w-[1400px]` wrappers, no nested scrollbars, no sub-tabs.
- **Inline actions.** Edit-in-place over modals. Modals only for irreversible actions (delete account, destructive confirms).
- **Drag-and-drop** for moving items between buckets (senders between folders, etc.) where it fits.
- **Empty states** are real copy with a next-step CTA, not "No data."

## Inngest

- `new Inngest({ id, isDev: process.env.INNGEST_DEV === "1" })`. Explicit. Never auto-detect.
- `INNGEST_DEV=1` is **local only** — never set in Vercel env.
- After any deploy that changes function signatures, re-sync the prod Inngest app.

## Error surfacing

- Wrap external/DB errors to surface `.cause` / `AggregateError.errors` / `code` / `syscall` / `address:port`. See `src/lib/errcause.ts`.
- "fetch failed" or "Failed query:" alone is not enough — we wasted multiple cycles on that. Always unwrap.

## Anti-patterns (don't do these)

- ❌ "While I'm in here, let me also…" — adjacent refactors. Every changed line must trace to the user's request.
- ❌ Adding a second source of truth (e.g. a settings field that duplicates a memory).
- ❌ Building speculative UI from screenshots of other products. Push back; ship the minimum.
- ❌ Silent spinners > 5s.
- ❌ Generic copy. "No data" → tell the user what to do.
- ❌ "Helpful" abstractions for single-use code.
- ❌ Catching errors to hide them. Let them surface with cause-chain unwrap.
- ❌ Modifying mail (move/delete/create folder) — not until Phase 3.
- ❌ Adding SQLite, `isMultiTenant()`, or dual-path branching to new code.
- ❌ Auto-detecting `isDev` for Inngest. Explicit env flag only.

## Git / release

- Commit message: `v{VERSION}: {brief description}`. Tag matching version.
- Patch / minor / major per CLAUDE.md.
- Never commit: `data/config.json`, `data/runs.json`, `data/summaries/`, `logs/`, `tasks/`.
- Stage explicit paths (`git add src/ scripts/ package.json …`) — not `git add -A`.

## Verification before "done"

- `npm run lint` clean.
- Playwright golden-path test passes (once the suite exists).
- For LLM-touching changes: eval pass (once evals exist).
- Manual end-to-end on a clean account for any onboarding / pipeline change.
- Prod-config differences considered: Inngest dev flag, pooler URL, token-hash auth flow, IPv6 vs IPv4.
