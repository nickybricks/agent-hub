# Plan

## In plain English (no jargon)
Right now, when you correct a personal fact in chat (e.g. "actually, call me Mai"), the assistant proposes a new version of your profile paragraph and you have to click "Apply" before it saves. The Profile tab then refreshes. This change skips the click: the assistant updates the paragraph in one step, the Profile tab refreshes on its own, and you don't see an Apply card. Other things in chat that change real mailbox stuff (folder edits, rules, audit actions) still ask first.

## My interpretation of the card
`update_persona` is currently a "mutate" chat tool, which means the chat loop pauses and shows an Apply/Cancel card before saving. The card asks me to:
1. Make `update_persona` execute immediately when the model calls it — no Apply card, no transcript-side "Confirmation required" UI.
2. Keep the side-pane refresh path working so the Profile tab updates without a page reload after the write lands.
3. Leave every other mutating tool (`rename_proposed_folder`, `set_proposed_folder_status`, `set_rule_status`, `update_rule_match`, `apply_rule`, `dismiss_audit_finding`, `set_audit_override`, `clear_pending_proposals`, `trigger_propose_structure`, `add_proposed_folder`, `write_memory`) on its existing confirm gate.
4. Append a DECISIONS.md entry explaining why persona is exempt.

## My approach
The existing chat loop in `streamLoop` (src/lib/chat-agent.ts) routes tools by their `kind`. `read` tools auto-execute and feed the result back to the model; `mutate` tools pause for confirmation. The cleanest fit for "auto-applies, but it writes" is the same shape the existing `save_onboarding_answer` already uses: it is registered as `kind: "read"` even though it writes (a `user_pref` memory). Following that precedent keeps the persona change consistent with how the codebase already handles auto-applying writes.

Concrete steps:

1. **`src/lib/chat-tools.ts`** — flip `update_persona`'s `kind` from `"mutate"` to `"read"`. Drop the "Requires user confirmation before it saves." sentence from its description. Move the write logic from `executeMutation`'s `update_persona` case into `runReadTool` (same body — insert new `user_profile` memory + supersede the prior one). Delete the now-unused `update_persona` cases in `previewMutation` and `executeMutation`. No other tool spec changes.

2. **`src/lib/chat-agent.ts`** — `SYSTEM_PROMPT` already tells the model to call `update_persona` with the full new text; no behavioural change needed there. The bullet "Mutating tools require the user's explicit confirmation" stays — it's still true for every remaining mutate tool. `update_persona` is no longer one of them, so the bullet doesn't contradict the new behaviour.

3. **Client refresh path** — no change needed. `ChatPanel.consume()` already calls `bump()` on every `tool` event with `phase: "done"`. `ProfilePane.useRevalidate(active, load)` already refetches `/api/mail-analyzer/profile` when the global revision advances and the pane is active. So a read-kind `update_persona` will (a) fire the tool-done event, (b) bump the revision, (c) cause ProfilePane to refetch live if it's the active tab, or on next tab-focus if not.

4. **DECISIONS.md** — append an entry "Persona updates auto-apply (no confirm card)" explaining the rationale (persona is low-stakes, easily re-corrected; confirm friction hurt the correction loop more than it protected the user; other mutating tools touch real mailbox data and keep confirm).

5. Verify: `npm run lint && npm run typecheck && npm run test:e2e`.

## Files I expect to touch
- `src/lib/chat-tools.ts`
- `docs/DECISIONS.md`

`src/lib/chat-agent.ts` I will re-read to confirm no prompt edit is needed; I do not expect to change it.

## Explicitly out of scope
- **Other mutating tools.** The card is persona-only. `rename_proposed_folder`, `set_proposed_folder_status`, `set_rule_status`, `update_rule_match`, `apply_rule`, `dismiss_audit_finding`, `set_audit_override`, `clear_pending_proposals`, `trigger_propose_structure`, `add_proposed_folder`, and `write_memory` keep their `kind: "mutate"` and their Apply/Cancel card.
- **`previewMutation` infrastructure.** Beyond removing the `update_persona` case, the function and its preview-rendering UI stay exactly as is.
- **The `/api/mail-analyzer/chat/confirm` route.** It's still the path for every remaining mutate tool. No change.
- **The `ProfilePane` `Save` button / manual edit flow.** The Profile tab's textarea + `PUT /api/mail-analyzer/profile` is unchanged — that's the user editing the persona directly, not the chat.
- **Adding a "persona just updated" toast / animation in the Profile tab.** The card asks for "reflects the new persona without a page reload" — the existing useRevalidate refetch satisfies that. A visual flash would be additive UI not in scope.
- **Backwards-compatibility for in-flight pending `update_persona` tool calls.** If any user happens to have a `pending` `update_persona` row at deploy time, the `/api/mail-analyzer/chat/confirm` route will reject it with `unknown mutating tool: update_persona` because the `executeMutation` case is gone. The window is small (pre-launch product, single-digit users, and a pending row only exists between the model's call and the user's click) and the user-visible failure is a single chat error message they can re-prompt past. Not building a shim.
- **Docs other than DECISIONS.md.** `PATTERNS.md` lists `update_persona` as a "Mutate tool"; that line will be wrong after this change. I'm not touching PATTERNS.md because the engineer prompt's "Do not touch" list calls out the mandatory-reading docs. Flagging as a follow-up in `decisions.md`.
- **Changing the chat system prompt language.** The model is already instructed to call `update_persona` with the full new text. Whether the user confirms or not is an implementation detail the model doesn't need to know.

## Open questions / assumptions
- **Assumption: `kind: "read"` is the right shape for "auto-applying write" in this codebase.** Precedent: `save_onboarding_answer` is `kind: "read"` and writes a `user_pref` memory. I'm treating that as a settled pattern rather than inventing a new `ToolKind`. The alternative would be to add a `kind: "mutate_auto"` literal, but PATTERNS.md "Anti-patterns" flags introducing abstractions for one-off code.
- **Assumption: the system prompt bullet "Mutating tools require the user's explicit confirmation" stays accurate after this change.** It does — `update_persona` is no longer a mutating tool by the tool-spec definition; it's a write that auto-runs. The bullet still applies to every tool tagged `mutate`.
- **Assumption: "Profile tab reflects the new persona without a page reload" is satisfied by the existing `useRevalidate` mechanism.** When the user is on the Profile tab, `useRevalidate(active=true, load)` re-runs `load` the moment the chat's `bump()` fires (which happens on every `tool done` event in the SSE stream). When the user is in chat (Profile inactive), the refetch is deferred until they tab over — still "no page reload." If the card wanted a literal "live update while staring at the Profile tab from another window" that would need a real-time subscription channel, but that's not what the card describes.
- **Assumption: the model's reasoning text accompanying the persona call still gets surfaced.** In the current `mutate` branch, the model's reasoning is persisted as an assistant message before the pending card. In the read-tool branch, the model's reasoning is the streamed `token` events that run into `liveText` and then settle into the persisted assistant message on the final iteration. Either way the user sees what the assistant said. I'm comfortable that the conversational UX is preserved (a sentence like "Got it — updated your profile.") because the read-tool branch continues the loop, so the model gets one more iteration to write that follow-up.
- No **BLOCKING** items.
