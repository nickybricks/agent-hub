#!/usr/bin/env -S npx tsx
/**
 * Engineer agent orchestrator (Phase 3 — manual dispatch).
 *
 * Invoked by .github/workflows/engineer.yml. Given a Notion card id, it:
 *   1. Fetches the card title + description.
 *   2. Runs Claude Code CLI in headless mode with an engineer prompt.
 *   3. Runs verify: lint + typecheck + test:e2e.
 *   4. On failure, re-invokes Claude once with the failure output.
 *   5. Exits 0 if final verify passes, non-zero otherwise.
 *
 * The workflow handles git/branch/PR/notify after this exits 0.
 *
 * Usage:
 *   npx tsx scripts/agent/engineer.ts <notion_card_id>
 *
 * Env: ANTHROPIC_API_KEY plus everything backlog.ts / playwright need.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { listBacklog, type BacklogItem } from "./backlog";

function writeFile(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const VERIFY_STEPS: Array<{ name: string; cmd: string; args: string[] }> = [
  { name: "lint", cmd: "npm", args: ["run", "lint"] },
  { name: "typecheck", cmd: "npm", args: ["run", "typecheck"] },
  { name: "test:e2e", cmd: "npm", args: ["run", "test:e2e"] },
];

interface VerifyResult {
  ok: boolean;
  failed?: string;
  output?: string;
}

function runVerify(): VerifyResult {
  for (const step of VERIFY_STEPS) {
    console.log(`\n=== verify: ${step.name} ===`);
    const res = spawnSync(step.cmd, step.args, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    });
    const out = (res.stdout ?? "") + (res.stderr ?? "");
    process.stdout.write(out);
    if (res.status !== 0) {
      return { ok: false, failed: step.name, output: out.slice(-8000) };
    }
  }
  return { ok: true };
}

function buildPrompt(card: BacklogItem, previousFailure?: VerifyResult): string {
  const base = [
    `You are the Engineer agent for the mail-workflow project. You have write access to the repo and may use Edit, Write, Read, Bash, Glob, Grep.`,
    ``,
    `## Mandatory reading before any change`,
    `Read these files first. Do not skip — your changes must be consistent with them:`,
    `  - CLAUDE.md`,
    `  - docs/PRODUCT.md`,
    `  - docs/DECISIONS.md`,
    `  - docs/PATTERNS.md`,
    `  - tasks/next-session-kickoff.md (current state snapshot incl. open caveats)`,
    ``,
    `## Your task — Notion card`,
    ``,
    `### ${card.title}`,
    ``,
    card.description || "(no description provided)",
    ``,
    `## Required workflow — plan, then build, then explain`,
    ``,
    `You MUST follow this order. Do not start editing code before writing the plan.`,
    ``,
    `### Step 1 — Read the mandatory docs (above).`,
    ``,
    `### Step 2 — Write \`.agent/plan.md\` BEFORE touching any code.`,
    `Use exactly this structure:`,
    ``,
    `\`\`\`markdown`,
    `# Plan`,
    ``,
    `## In plain English (no jargon)`,
    `2–4 sentences a non-technical person can read and understand. What does the card actually want, in everyday terms? What's the user-visible outcome?`,
    ``,
    `## My interpretation of the card`,
    `Restate the card in your own words. If it's ambiguous, say so and pick the most conservative interpretation.`,
    ``,
    `## My approach`,
    `Bullets. What I'm going to do, in order.`,
    ``,
    `## Files I expect to touch`,
    `Bullets with paths.`,
    ``,
    `## Explicitly out of scope`,
    `Bullets. Things that look related but I am NOT going to do. Be specific — name files, features, or behaviors I'm leaving alone.`,
    ``,
    `## Open questions / assumptions`,
    `Bullets. Anything I had to guess at. If something is genuinely blocking — I can't make a safe choice without an answer — start that bullet with **BLOCKING:**.`,
    `\`\`\``,
    ``,
    `### Step 3 — Decide whether to proceed.`,
    `Re-read your plan. If any bullet in "Open questions / assumptions" starts with **BLOCKING:**, OR if the card conflicts with PRODUCT.md / DECISIONS.md, OR if the only path forward requires destructive changes the card didn't authorize, OR if you'd have to touch files in the "Do not touch" list — **STOP. Do not edit code. Exit.** The workflow will read your plan.md and forward the questions to the human via Telegram. They will sharpen the card and the agent will run again.`,
    ``,
    `### Step 4 — Implement.`,
    `Make the changes. Stay surgical. Every changed line should trace to the card.`,
    ``,
    `### Step 5 — Write \`.agent/decisions.md\` AFTER the changes are done.`,
    `Use exactly this structure:`,
    ``,
    `\`\`\`markdown`,
    `# Decisions`,
    ``,
    `## In plain English (no jargon)`,
    `2–4 sentences a non-technical person can read. What did you actually change, and what will the user / reviewer notice as a result?`,
    ``,
    `## What changed`,
    `Bullets per file. Path + one-line description of the change.`,
    ``,
    `## Why these choices`,
    `Bullets. Non-obvious decisions and the reasoning. If you picked option A over option B, say what B was and why A won. If a choice came from PATTERNS.md or DECISIONS.md, name the section.`,
    ``,
    `## Judgment calls I made`,
    `Bullets. Anywhere you had to guess because the card didn't say. Be honest — these are the things the reviewer should focus on.`,
    ``,
    `## What I deliberately did NOT do`,
    `Bullets. Stuff that seemed adjacent and tempting but I left alone.`,
    ``,
    `## Risks and follow-ups`,
    `Bullets. Anything the reviewer should double-check, anything that should become a follow-up card, anything that could break in production.`,
    `\`\`\``,
    ``,
    `### Step 6 — Self-verify.`,
    `Run \`npm run lint && npm run typecheck && npm run test:e2e\`. If it fails, fix it before exiting. If a fix changes the decisions.md, update it.`,
    ``,
    `## Hard rules`,
    `  - **Stay strictly inside the card scope.** If you find yourself doing something the card description didn't explicitly ask for, STOP and add it to "Open questions" in plan.md as **BLOCKING:**.`,
    `  - **Destructive actions need explicit authorization in the card.** Do not delete files, drop schemas, remove routes, or rip out features unless the card explicitly says "delete X" / "remove Y". "Redirect", "move", "rename", "update" are NOT authorization to delete.`,
    `  - **Surgical changes only.** Follow CLAUDE.md Simplicity First and Surgical Changes. Every changed line must trace to the card.`,
    `  - **Match existing patterns.** Read docs/PATTERNS.md and mimic the style — don't invent new abstractions for one-off code.`,
    `  - **Do not touch:** \`.github/\`, \`scripts/agent/\`, \`playwright.config.ts\`, \`tasks/\`, version numbers in \`package.json\`, or this prompt's mandatory-reading docs, unless the card explicitly names them.`,
    `  - **\`.agent/\` IS allowed — that's where plan.md and decisions.md go.**`,
    `  - **Do not commit, push, or open a PR.** The workflow handles git after you exit.`,
    `  - **Write for a non-technical reader in the "In plain English" sections.** No code identifiers, no acronyms without expansion, no internal jargon. If you must use a technical term, give a 3-word gloss in parens.`,
    ``,
    `When the task is done and verify passes locally, exit. The workflow will then re-run verify and either ship a PR or call you back with the failure output.`,
  ].join("\n");

  if (!previousFailure) return base;

  return [
    base,
    ``,
    `## Previous attempt failed verify`,
    ``,
    `Step: ${previousFailure.failed}`,
    ``,
    "```",
    previousFailure.output ?? "(no output)",
    "```",
    ``,
    `This is your one and only retry. Fix the failure, update \`.agent/decisions.md\` to reflect any new judgment calls, and exit.`,
  ].join("\n");
}

function runClaude(prompt: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "-p",
        prompt,
        "--model",
        "claude-opus-4-7",
        "--dangerously-skip-permissions",
        "--allowedTools",
        "Edit,Write,Read,Bash,Glob,Grep",
      ],
      { stdio: "inherit", env: process.env },
    );
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function loadCard(cardId: string): Promise<BacklogItem> {
  const all = await listBacklog();
  const card = all.find((c) => c.id === cardId);
  if (!card) throw new Error(`card not found: ${cardId}`);
  return card;
}

async function main() {
  const cardId = process.argv[2];
  if (!cardId) {
    console.error("usage: engineer.ts <notion_card_id>");
    process.exit(1);
  }

  const card = await loadCard(cardId);
  console.log(`\nCard: ${card.title}\nStatus: ${card.status}\nPriority: ${card.priority ?? "—"}\n`);

  const code1 = await runClaude(buildPrompt(card));
  if (code1 !== 0) {
    console.error(`claude exited ${code1}`);
    process.exit(code1);
  }

  let verify = runVerify();
  if (verify.ok) {
    console.log("\n✅ verify passed on first attempt");
    return;
  }

  console.log(`\n⚠️  verify failed at ${verify.failed} — invoking Claude for retry`);
  const code2 = await runClaude(buildPrompt(card, verify));
  if (code2 !== 0) {
    console.error(`claude retry exited ${code2}`);
    process.exit(code2);
  }

  verify = runVerify();
  if (verify.ok) {
    console.log("\n✅ verify passed after retry");
    return;
  }

  console.error(`\n❌ verify still failing at ${verify.failed} after retry`);
  // Persist last verify failure so the workflow can include it in the 🔴 ping.
  writeFile(
    ".agent/verify-failure.txt",
    `Step: ${verify.failed}\n\n${verify.output ?? "(no output)"}`,
  );
  process.exit(1);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
