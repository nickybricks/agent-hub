# Product — what we're building and for whom

**Read this first.** An autonomous task is on-brand only if it can answer "yes" to every section below.

---

## One-line pitch

A persona-driven inbox declutterer. Users connect their mailbox, the agent learns who they are from their email, proposes a folder structure that fits *their* life, and applies it under their control.

## Who it's for

Knowledge workers / founders / "power-inbox" users drowning in newsletters, receipts, and stale senders. They already tried Gmail labels and rules. They want a **calm overview**, not another data dashboard.

## North stars

These override convenience. If a feature violates one, push back before building.

1. **Calm overview, not data dump.** Every screen is glanceable on one viewport. Progressive disclosure beats scrolling. If a pane needs `max-w-[1400px]` and three sub-tabs, it's wrong.
2. **Inline apply, drag-and-drop where it fits.** Direct manipulation > modals > settings pages. The chat panel is the escape hatch for anything without a direct control.
3. **Persona-informed, not generic.** Every LLM call that produces user-visible output (proposals, summaries, chat) should consume the persona memory. Generic taxonomy = failure mode.
4. **Honest loading copy.** Name what's running ("Drafting your profile · Usually 5–30 seconds"), show live progress (folder counts streaming in), never spin in silence.
5. **User stays in control.** The agent proposes; the user accepts. No destructive mail writes without an explicit, reversible action. (Mail-write tooling is Phase 3 — until then, show disabled actions with a tooltip rather than hide them.)

## Voice and aesthetic

- **Wordmark:** burgundy → green gradient. Use the existing tokens, don't invent new ones.
- **Tone:** plain, second-person, no marketing puff. "Currently in build" beats "Revolutionizing inbox management." German-bluntness over American-enthusiasm.
- **Empty states are real copy**, not "No data." Tell the user what to do next.
- **No emoji in product UI** unless the user explicitly asks.

## Scope discipline

- **In scope:** anything that reads mail + writes to our own Postgres (rules, proposals, memories, audit).
- **Out of scope until Phase 3:** anything that writes back to the user's mailbox (folder create/rename, move, delete). Surface as disabled with a "coming once folder writes are wired" tooltip — don't hide the gap.
- **Not a product:** the legacy newsletter-digest CLI in `src/agent/run.ts` + `send-digest.ts`. Dead code, will be swept.

## How to know a feature is done

1. Works end-to-end on a clean account.
2. Has a Playwright golden-path test or, for LLM-touching code, an eval.
3. Touched files trace 1:1 to the user's request — no adjacent "improvements."
4. Honest loading + empty + error states.
5. Persona memory consumed where relevant.
6. New decision worth remembering? Append to `DECISIONS.md` as part of the PR.
