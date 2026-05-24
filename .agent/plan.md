# Plan

## In plain English (no jargon)
During first-time setup, after the system reads your mailbox, it asks an AI to write a short profile of you. While that's running, the chat shows a "Drafting your profile · Usually 5–30 seconds" loading note. Right now, sometimes that loading note never goes away — the profile is actually finished on the server side, but the chat panel never picks it up. Refreshing the page reveals it was done all along.

I'm going to add a safety net: if the loading note has been stuck for more than 5 seconds, the chat will quietly ask the server again whether the profile is ready. That extra check should rescue the UI from getting stranded.

## My interpretation of the card
A specific failure mode: after classify completes and the pipeline reaches phase `persona_ready`, the React effect in `ChatPanel.tsx` that POSTs to `/onboarding/persona-draft` either (a) hangs on a fetch that never resolves, or (b) gets its in-flight response discarded because of a stale-closure / cancellation race. The server *does* write the `onboarding_persona_draft` system memory, but `setPersona(...)` never fires, so the spinner never flips and the editor card never appears.

The current code (after the v0.38.1 fix) only schedules its 5s retry **after** the awaited POST settles. If the POST never settles, the retry is never scheduled, and the UI is stranded.

The card asks for the conservative defensive fix: if `persona_ready` is still showing 5s after the draft POST was sent, refetch once. That covers the "POST hangs / response lost" case without rewriting the existing retry-on-failure logic.

## My approach
1. Add a small one-shot watchdog effect in `src/components/ChatPanel.tsx`:
   - Runs when `pipeline?.phase === "persona_ready"` and `persona` is still null.
   - Schedules a single 5-second timer.
   - When it fires, bumps `personaRetry` (the existing retry counter), which re-runs the persona-draft fetch effect and POSTs again.
   - Cleanup clears the timer, so as soon as `persona` is set (or the phase moves on), the watchdog is cancelled.
   - Deps: `[pipeline?.phase, persona]`. Because `personaRetry` is **not** in the deps, the watchdog fires at most **once per entry into `persona_ready`** — matching the card's "refetch once" wording.
2. Leave the existing persona-draft fetch effect alone — it already handles the "POST returned definitively with no persona / error" case via its own 5s retry timer. The watchdog only covers the "POST never settled" case.
3. Verify by reading the diff carefully, then run `npm run lint && npm run typecheck && npm run test:e2e`. There is no Playwright onboarding spec to cover this directly (`e2e/` has `landing.spec.ts` and `sign-in.spec.ts` only), so the e2e suite is a smoke check, not the acceptance test. The acceptance test is the manual flow described on the card; I'll call that out in `decisions.md`.

## Files I expect to touch
- `src/components/ChatPanel.tsx`

## Explicitly out of scope
- **Not rewriting** the existing persona-draft fetch effect (lines ~300–328). It already does the right thing on definitive failures; adding the watchdog is additive.
- **Not changing** `/api/mail-analyzer/onboarding/persona-draft/route.ts`. The server side already idempotently caches the draft as a `system` / `onboarding_persona_draft` memory — that's exactly what makes the defensive refetch cheap.
- **Not changing** `/api/mail-analyzer/onboarding/pipeline/route.ts`. Phase progression logic is correct.
- **Not adding** an onboarding Playwright spec. The repo has no onboarding e2e fixture (the persona pipeline depends on Inngest + a live mailbox), so writing one would be a much bigger task than this card asks for.
- **Not touching** the polling effect (lines ~270–293), the elapsed-time effect, `loadThread`, `newChat`, `consume`, or any unrelated state. Surgical, per CLAUDE.md.
- **Not** bumping the package version, per the engineer-task hard rules.

## Open questions / assumptions
- Assuming the card's "refetch once" really means "one defensive refetch per entry into `persona_ready`", not "one refetch ever across all onboarding runs". My implementation gives one per entry — if the user clicks "Rebuild profile" later, that restarts onboarding and the watchdog gets a fresh shot. This matches every other state reset in the file (`setPersona(null)`, `setPipeline(null)` etc.).
- Assuming we should NOT abort the original in-flight POST. If the original POST eventually resolves with a persona, its result is just ignored (the closure's `cancelled` flag goes true when the watchdog triggers `setPersonaRetry`, which re-runs the fetch effect and cancels the previous IIFE). The duplicate work is cheap because the route returns the cached memory if it exists, and Sonnet calls are idempotent enough that even if both syntheses run, the user just gets the second one.
- Assuming a 5s watchdog is the right threshold. Synthesis usually takes 5–30s, so 5s is aggressive — but the existing loading copy already says "Usually 5–30 seconds", and a healthy POST that's still in flight at 5s will just trigger a second POST that finds the cached memory once the first one finishes writing. Not a regression.
- Assuming the `[pipeline?.phase, persona]` dep array is correct. When `persona` flips from null to set, the cleanup clears the watchdog before it can fire (or before its retry would have any effect). When phase leaves `persona_ready`, cleanup also clears it. Both are the right behaviour.
