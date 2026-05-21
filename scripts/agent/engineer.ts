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
    `You are the Engineer agent for the mail-workflow project. You have full write access to the repo and may use Edit, Write, and Bash tools.`,
    ``,
    `Before doing anything, read these files for context:`,
    `  - CLAUDE.md`,
    `  - docs/PRODUCT.md`,
    `  - docs/DECISIONS.md`,
    `  - docs/PATTERNS.md`,
    `  - tasks/next-session-kickoff.md (state snapshot only — task queue lives in Notion)`,
    ``,
    `Your task is the following Notion card:`,
    ``,
    `## ${card.title}`,
    ``,
    card.description || "(no description provided)",
    ``,
    `Constraints:`,
    `  - Make surgical changes. Follow CLAUDE.md (Simplicity First, Surgical Changes).`,
    `  - Do not commit, push, or open a PR — the workflow handles git after you exit.`,
    `  - Do not edit playwright.config.ts, .github/, or scripts/agent/ unless the card explicitly requires it.`,
    `  - When done, your changes must pass: npm run lint && npm run typecheck && npm run test:e2e.`,
    `  - You may run those commands yourself to self-check before finishing.`,
    ``,
    `When you believe the task is complete, exit. The workflow will then run verify and either ship a PR or call you back with the failure output.`,
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
