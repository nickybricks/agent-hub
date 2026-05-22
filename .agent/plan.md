# Plan

## In plain English (no jargon)
Right now the Profile tab in the app shows the same idea in two places: a short paragraph the assistant wrote about you (the "persona"), and a bullet list of personal facts you've told the chat (the "About you" section). When you correct yourself in chat (e.g. "actually I'm a designer, not a developer"), only the bullet list updates — the paragraph stays wrong, so the two sections disagree.

This change merges them into one. The Profile tab will show a single "Your persona" section. When you correct a fact in chat, the assistant updates the whole persona paragraph (with your confirmation), and the Profile tab refreshes to match.

## My interpretation of the card
Two memory kinds (`soul` and `user_profile`) currently hold overlapping information. The card asks to:
1. Keep one canonical store (use the existing `user_profile` kind).
2. Add a new mutating chat tool `update_persona` that replaces the persona text (requires user confirmation, per the card's "mutate tool" + "confirms" wording).
3. Retire `remember_about_user` (the card explicitly prefers "drop it" over "trigger re-synth").
4. Remove the "About you" section from the Profile tab — one inline-editable section only.
5. The onboarding persona-confirm flow already writes to `user_profile` — keep that behaviour.
6. The chat agent's system prompt currently injects the `soul` memory as "what you know about this user" context. Switch that to inject the `user_profile` (the unified persona) instead.

Conservative reads:
- "Retire `remember_about_user`" = remove the tool spec + handler. The card is explicit. I will NOT drop the `soul` memory rows from the database — that's destructive and not authorized. Soul rows simply become unread/unwritten by app code; they remain in `agent_memory` for forensic value.
- During onboarding, the assistant still needs a place to remember the user's name + bot nickname after they answer the warm-intro questions. Since `remember_about_user` is gone, I'll route those answers through the existing `save_onboarding_answer` tool with new keys (`name`, `bot_name`, `personal_context`). They become `user_pref` rows like the rest of the questionnaire, and `synthesizePersona` already reads `user_pref` answers — so the name and any context fold naturally into the synthesised persona paragraph.

## My approach
1. **`src/lib/chat-tools.ts`** — remove `remember_about_user` (spec + handler in `runReadTool`). Add `update_persona` as a `mutate` tool: takes `content` (the new full persona text), preview shows a truncated diff-style summary, execute supersedes the prior `user_profile` memory with the new one. If no persona exists yet, it inserts one.
2. **`src/lib/chat-agent.ts`** —
   - Replace the `soul`-memory read + system-prompt injection block with a `user_profile` read + injection block ("What you know about this user…"). Same shape, different memory kind.
   - In `onboardingState`, drop the `hasSoul` field. Use `answered` (now including `name`) to gate the warm-intro step.
   - Update the STATE line: replace "soul memory: saved/NOT yet" with the existing answered-list (which now carries the warm-intro answers).
   - Update `SYSTEM_PROMPT`: drop the `remember_about_user` instruction. Add: "When the user corrects or volunteers a durable personal fact about themselves, call `update_persona` once with the new FULL persona text (preserve everything still true, fold in the new fact)."
   - Update `ONBOARDING_SYSTEM_PROMPT`: step 2 saves via `save_onboarding_answer key: name` (and `bot_name` if offered) instead of `remember_about_user`; step 5 saves via `save_onboarding_answer key: personal_context` instead of `remember_about_user`. Step 1 gate switches from "no soul memory yet" to "no `name` answered yet".
3. **`src/app/api/mail-analyzer/profile/route.ts`** — drop `soul` from the `ProfilePayload` shape, the `shape()` derivation, and the PUT handler's `soul` branch. Persona-only.
4. **`src/components/panes/ProfilePane.tsx`** — remove the "About you" section, its state (`soul`, `soulDraft`, `savingSoul`, `saveSoul`), and the `soul` field from the `ProfileData` interface. Keep the "Your persona" section exactly as is (already inline-editable).
5. **`src/lib/onboarding.ts`** (`synthesizePersona`) — already reads `user_pref` answers and folds them into the prompt. The new `name`/`bot_name`/`personal_context` keys flow in automatically; no change needed beyond the existing loop. Skim the prompt to make sure nothing else needs to fold soul in.
6. Acceptance check: in dev, ask the chat to correct a fact → confirm the Apply card → flip to the Profile tab → see the updated persona without an F5 reload (the existing `useDataBump` / `useRevalidate` plumbing already does this for other mutate tools).
7. `npm run lint && npm run typecheck && npm run test:e2e`.

## Files I expect to touch
- `src/lib/chat-tools.ts`
- `src/lib/chat-agent.ts`
- `src/app/api/mail-analyzer/profile/route.ts`
- `src/components/panes/ProfilePane.tsx`

Maybe (no change expected, only re-reading): `src/lib/onboarding.ts`, `src/app/api/mail-analyzer/onboarding/persona/route.ts`.

## Explicitly out of scope
- **Not dropping the `soul` memory kind from the database** (`MemoryKind` union in `src/lib/analyzer-db.ts`) or doing any data migration. Existing `soul` rows stay where they are; the app simply stops reading or writing them. Removing the type literal would be a wider refactor of the memory schema, which the card didn't ask for, and dropping rows is destructive without authorization.
- **Not touching `src/lib/greeting.ts`** — it already reads `user_profile`, so it gets the unified persona for free.
- **Not touching `src/agent/propose-structure.ts`** — same: it already reads `user_profile`.
- **Not changing `src/app/api/mail-analyzer/onboarding/persona/route.ts`** — already writes `user_profile`.
- **Not updating `docs/PATTERNS.md` or `docs/CHAT-FLOW.md`** — task prompt says don't touch the mandatory-reading docs; I'll log the doc-drift note in `decisions.md` as a follow-up.
- **Not building a re-synth path** ("append fact + trigger persona re-synth"). The card calls that out explicitly as the alternative and prefers "drop it and have bot call update_persona with new full text" — I'm going with the simpler path.
- **Not adding a free-text capture mechanism in chat for personal facts pre-onboarding** — the existing `save_onboarding_answer` covers the three slots (name, bot_name, personal_context).

## Open questions / assumptions
- Assuming `update_persona` should require explicit user confirmation (Apply/Cancel card) because the card calls it a "mutate tool" that "confirms". Friction during a correction is acceptable; mutations of saved memory should be visible.
- Assuming dropping `remember_about_user` and routing the warm-intro answers through `save_onboarding_answer` is acceptable. The alternative (auto-running `update_persona`) requires a persona to already exist, which it doesn't pre-pipeline.
- Assuming we should NOT delete pre-existing `soul` rows in the database; the card says "retire" / "drop the tool", not "delete the data". After the change, those rows are orphaned but harmless.
- The acceptance test ("correcting a fact in chat rewrites displayed persona in Profile tab without reload") relies on the existing `useDataBump` mechanism in `ChatPanel`, which fires after every mutate tool finishes. The Profile tab's `useRevalidate(active, load)` will refetch when it becomes active. This is "no F5 reload"; if the user is staring at the Profile tab while typing in chat, the refetch happens the moment they tab back. I'm reading "without reload" as "no page reload", which matches the existing UX pattern for every other mutate tool.
