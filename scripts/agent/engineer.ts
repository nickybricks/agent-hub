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
import { listBacklog, type BacklogItem } from "./backlog";

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
    `## Hard rules`,
    `  - **Stay strictly inside the card scope.** If you find yourself doing something the card description didn't explicitly ask for, STOP. Exit without changes and the human will sharpen the card.`,
    `  - **Destructive actions need explicit authorization in the card.** Do not delete files, drop schemas, remove routes, or rip out features unless the card explicitly says "delete X" / "remove Y". "Redirect", "move", "rename", "update" are NOT authorization to delete.`,
    `  - **Surgical changes only.** Follow CLAUDE.md Simplicity First and Surgical Changes. Every changed line must trace to the card.`,
    `  - **Match existing patterns.** Read docs/PATTERNS.md and mimic the style — don't invent new abstractions for one-off code.`,
    `  - **Do not touch:** \`.github/\`, \`scripts/agent/\`, \`playwright.config.ts\`, \`tasks/\`, version numbers in \`package.json\`, or this prompt's mandatory-reading docs, unless the card explicitly names them.`,
    `  - **Do not commit, push, or open a PR.** The workflow handles git after you exit.`,
    `  - **Self-check before exiting:** run \`npm run lint && npm run typecheck && npm run test:e2e\` yourself. If it fails, fix it before exiting.`,
    ``,
    `## When to exit with no changes`,
    `  - The card description is too vague to act on safely.`,
    `  - The card asks for something that conflicts with PRODUCT.md / DECISIONS.md.`,
    `  - You'd have to make destructive changes the card doesn't authorize.`,
    `  - You'd have to touch files in the "Do not touch" list.`,
    `In any of these cases, leave a one-line summary on stdout explaining why and exit. The human will adjust the card.`,
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
    `This is your one and only retry. Fix the failure and exit.`,
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
  process.exit(1);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
