#!/usr/bin/env -S npx tsx
/**
 * One-shot: migrate the 8 START HERE items from next-session-kickoff.md
 * into Notion backlog cards. Safe to re-run — skips cards whose title already exists.
 *
 * Delete this script after the migration if you like; it's not part of the agent loop.
 */

const NOTION_VERSION = "2022-06-28";

interface Card {
  title: string;
  priority: "Hoch" | "Mittel" | "Niedrig";
  description: string;
}

const CARDS: Card[] = [
  {
    title: "Persona draft loading view doesn't auto-finish",
    priority: "Hoch",
    description: `Symptom: during onboarding, after classify completes and Sonnet writes the persona draft, the chat keeps showing the "Drafting your profile · Usually 5–30 seconds" spinner indefinitely. Reloading reveals the draft was finished much earlier — work completes server-side, UI doesn't pick it up without a remount.

Where to look:
• src/components/ChatPanel.tsx — useEffect polling /onboarding/pipeline that POSTs to /onboarding/persona-draft on phase: persona_ready. Suspicion: polling stops too early, or draft response never flips local loading flag.
• src/app/api/mail-analyzer/onboarding/persona-draft/route.ts — confirm it writes draft as system memory (key onboarding_persona_draft) and returns it on the same call.
• personaFetched.current guard — once true never re-fetches; failed initial fetch silently strands UI.

Acceptance: trigger onboarding from clean account → draft appears within seconds of classify finishing, no reload. Defensive: if persona_ready persists >5s after draft POST, refetch once.`,
  },
  {
    title: 'Merge "About you" + "Persona" into one canonical profile',
    priority: "Mittel",
    description: `Why: same concept stored twice — soul memory (first-person bullets from remember_about_user) vs user_profile (Sonnet-synthesized paragraph written once at persona-confirm). Telling chat "no, I'm actually X" appends a soul bullet; the persona paragraph stays untouched → two sections that disagree.

Proposed shape:
• One canonical persona document (paragraph + optional bullets), one memory kind.
• New mutate tool update_persona — replaces persona text; confirms.
• remember_about_user retires OR becomes "append fact + trigger persona re-synth that folds it in." Simpler: drop it and have bot call update_persona with new full text.
• Profile tab shows one section, inline-editable (calls update_persona under the hood).
• Onboarding persona-confirm writes to the same store.
• System prompt's soul-context block injects unified persona.

Effort: ~3–5h. Touches onboarding persona-confirm route, chat-tools, ProfilePane, soul/user_profile injection in src/lib/chat-agent.ts.

Acceptance: correcting a fact in chat rewrites displayed persona in Profile tab without reload.`,
  },
  {
    title: "Chat cost guardrails (router + per-user budget)",
    priority: "Niedrig",
    description: `Every chat turn defaults to Claude Sonnet 4.6 (~4–5¢ per interaction). At scale this is profitable-SaaS vs hobby-cost-sink.

Two strands:
• Router heuristic — Haiku 4.5 fallback for short factual asks / chip handling / confirmation turns. Earlier design: project-chat-llm-router memory. Status: not implemented, everything still picks Sonnet.
• Per-user daily/monthly budget — needs usage-tracking table + middleware in src/lib/chat-agent.ts. At minimum a hard daily ceiling returning a friendly chat message.

Pricing math: Sonnet 4.6 $3/M input + $15/M output. Typical turn ~3k in + ~500 out = ~1.5¢ × 2–3 turns = the 4–5¢ figure. Haiku 4.5 ~10× cheaper.

No code yet — log for visibility. Revisit triggers: real users signing up, or chat-turn frequency increasing.

Acceptance: per-turn cost visible in LangSmith dashboard; router lab-tested on N=20 turns with classification quality recorded; budget table + middleware shipped behind feature flag.`,
  },
  {
    title: 'New "Folders" tab — current structure view',
    priority: "Mittel",
    description: `Why: the moment a proposal is accepted, the dashboard goes silent about that folder. User has no in-app view of "what's my current mailbox structure?" — only Proposals (pending) / Audit / History.

Shape (user spec 2026-05-20): new tab between Home and Proposals, laid out like a mail-client folder tree but richer.
• Tree view: top-level folders + accordion for subfolders (split paths on /).
• Per row: folder name, message count, short summary (top categories + top senders).
• Click → modal: rules routing mail here, senders each rule catches, sample subjects.
• Inline edits in popup: edit rule (match_value / confidence / target), delete rule, toggle active/inactive, add rule.
• Empty state: "Accept a proposal to start building your structure."

Scope split:
✅ In scope (DB-only): the view, rule edits/delete/toggle/add. Pure Postgres writes via folder_rules.
❌ Out of scope until mail-write tooling (Phase 3): rename folder, delete folder, create folder from this tab. Show as disabled with "coming once folder writes are wired" tooltip.

Data already exists: getProposalFolderRowsPg, folder_rules table, getTopSendersForMailboxPg.

Files: src/components/panes/FoldersPane.tsx (new), src/app/app/page.tsx (add to TABS array).

Effort: ~2h read-only first pass; rule editing follow-up.

Phase-3 detail: accepted proposals should move out of Proposals tab onto this Folders tab — destination view for the full accepted-folder lifecycle.

Acceptance: new tab visible between Home and Proposals; lists current folders with counts + top senders; click opens rule editor modal; inline rule edits persist to folder_rules and refresh the view.`,
  },
  {
    title: "Streaming proposals — deferred perf options",
    priority: "Niedrig",
    description: `After measuring v0.35.0 streaming in the wild. Next perf tier only if streaming alone isn't enough on real-scale mailboxes:

• Cache + diff on rebuild — only re-propose for senders new or moved-category since last run. Rebuild on stable mailbox: <30s. ~2–3h.
• Two-pass split (folder design + parallel per-folder rule gen) — ~3× cost, marginal wall-time gain. Right move at 5–10k+ senders. ~4–6h.
• Haiku 4.5 for pass 2 (only if two-pass adopted) — drops cost to ~2× today. Needs eyeball quality check on a few proposal sets.

Acceptance: not yet — gate this on real-world measurements of v0.35.0 first.`,
  },
  {
    title: "SQLite removal step 3 cleanup",
    priority: "Niedrig",
    description: `Dual-path branching is gone everywhere; two finishing tasks remain. Full plan: tasks/sqlite-removal-plan.md.

• Gut src/lib/analyzer-db.ts + src/lib/chat-db.ts to types only. No consumer imports runtime functions anymore — only types (and SENDER_CATEGORIES const). Drop everything else; files become small type-export modules.
• Rename *-pg.ts → drop suffix, sed-rename every *Pg call site to unsuffixed (optional tidy).
• package.json: remove better-sqlite3 + @types/better-sqlite3; npm install; npm test.
• Cleanup pass on legacy newsletter dashboard (also dead): src/app/api/agents/, src/app/api/runs/, src/app/api/summaries/, src/app/api/settings/ (non-mail), src/lib/data.ts. / now redirects to /app so they're unreferenced. Delete or leave for separate sweep.

Acceptance: better-sqlite3 absent from package.json; npm test green; grep -r "from \\"better-sqlite3\\"" returns nothing.`,
  },
  {
    title: "Redirect old /mail-analyzer/* → /app (308)",
    priority: "Niedrig",
    description: `Legacy /mail-analyzer/* routes still live. /app is the product; old pages should 308 redirect.

Acceptance: navigating to any /mail-analyzer/* URL serves a 308 to /app (or /app/{matching-pane} where possible); no orphaned routes remain in src/app/mail-analyzer/.`,
  },
  {
    title: "Landing page polish (waitlist SQL, Higgs Field, domain)",
    priority: "Hoch",
    description: `Hero shipped in v0.38.0. Open items:

• [HOCH] Run waitlist SQL in prod Supabase — scripts/sql/2026-05-21-waitlist.sql. Until then the form returns 500. This is a manual action, not a code change.
• [MITTEL] Higgs Field render — replace src/components/landing/DeclutterPreview.tsx with a <video> tag pointing at public/landing/declutter.mp4 once the animation lands. Prompt in chat history.
• [NIEDRIG] Optional /landing alias — non-redirecting copy so we can share the page with logged-in viewers for feedback.
• [MITTEL] Custom domain — currently only on mail-workflow.vercel.app.

Acceptance (waitlist SQL only — the other items become their own cards if/when prioritized): waitlist form on / submits successfully against prod Supabase with no 500.`,
  },
];

async function main() {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_BACKLOG_DB_ID;
  if (!token || !dbId) throw new Error("NOTION_TOKEN + NOTION_BACKLOG_DB_ID required");

  // Fetch existing titles so we don't duplicate
  const existing = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ page_size: 100 }),
  }).then((r) => r.json());

  type SeedPage = { properties?: { Task?: { title?: { plain_text: string }[] } } };
  const existingTitles = new Set<string>(
    (existing.results as SeedPage[]).map((p) =>
      (p.properties?.Task?.title ?? []).map((t) => t.plain_text).join(""),
    ),
  );

  for (const card of CARDS) {
    if (existingTitles.has(card.title)) {
      console.log(`skip (exists): ${card.title}`);
      continue;
    }
    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { database_id: dbId },
        properties: {
          Task: { title: [{ text: { content: card.title } }] },
          Status: { status: { name: "Backlog" } },
          Priority: { select: { name: card.priority } },
          Description: {
            rich_text: [{ text: { content: card.description.slice(0, 2000) } }],
          },
        },
      }),
    });
    if (!res.ok) {
      console.error(`FAIL: ${card.title} — ${res.status} ${await res.text()}`);
      continue;
    }
    console.log(`created [${card.priority.padEnd(7)}]: ${card.title}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
