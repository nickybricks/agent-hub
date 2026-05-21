/**
 * Spec-drift check.
 *
 * Every agent spec in docs/agents/*.md carries frontmatter pointing at its
 * source file plus the SHA-256 the spec was last reconciled against:
 *
 *   ---
 *   agent: triage
 *   source: src/agent/triage.ts
 *   source_sha256: <hash>
 *   updated: 2026-05-19
 *   ---
 *
 * This script recomputes each source's hash and reports any agent whose code
 * changed without its spec being touched. It exits non-zero on drift so it can
 * gate a pre-push hook or be run manually after editing an agent.
 *
 * Usage:
 *   npx tsx scripts/check-spec-drift.ts            # report drift, exit 1 if any
 *   npx tsx scripts/check-spec-drift.ts --update   # re-baseline hashes after review
 */
import { createHash } from "crypto";
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

const ROOT = process.cwd();
const SPEC_DIR = join(ROOT, "docs", "agents");
const UPDATE = process.argv.includes("--update");

interface Spec {
  file: string;
  agent: string;
  source: string;
  sha: string;
}

function parseFrontmatter(path: string): Spec | null {
  const raw = readFileSync(path, "utf-8");
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = m[1];
  const get = (k: string) => fm.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1].trim();
  const agent = get("agent");
  const source = get("source");
  const sha = get("source_sha256");
  if (!agent || !source || !sha) return null;
  return { file: path, agent, source, sha };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const specs = readdirSync(SPEC_DIR)
  .filter((f) => f.endsWith(".md") && f !== "README.md")
  .map((f) => parseFrontmatter(join(SPEC_DIR, f)))
  .filter((s): s is Spec => s !== null);

const drifted: { agent: string; spec: Spec; actual: string }[] = [];

for (const spec of specs) {
  const actual = sha256(join(ROOT, spec.source));
  if (actual !== spec.sha) drifted.push({ agent: spec.agent, spec, actual });
}

if (drifted.length === 0) {
  console.log(`✅ All ${specs.length} agent specs are in sync with their source.`);
  process.exit(0);
}

if (UPDATE) {
  const today = new Date().toISOString().split("T")[0];
  for (const { spec, actual } of drifted) {
    const raw = readFileSync(spec.file, "utf-8")
      .replace(/^source_sha256:.*$/m, `source_sha256: ${actual}`)
      .replace(/^updated:.*$/m, `updated: ${today}`);
    writeFileSync(spec.file, raw);
    console.log(`🔄 Re-baselined ${spec.agent} (${spec.source})`);
  }
  console.log(
    `\nUpdated ${drifted.length} spec hash(es). Make sure the prose actually reflects the code changes.`,
  );
  process.exit(0);
}

console.error(`❌ ${drifted.length} agent spec(s) drifted from their source:\n`);
for (const { agent, spec } of drifted) {
  console.error(`  - ${agent}: ${spec.source} changed but docs/agents/${agent}.md was not re-baselined`);
}
console.error(
  `\nReview the code change, update the spec prose, then run:\n  npm run docs:check -- --update`,
);
process.exit(1);
