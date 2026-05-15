/**
 * Apply a single SQL migration file against DATABASE_URL.
 * Splits on Drizzle's `--> statement-breakpoint` and runs each chunk in order.
 *
 * Usage: npx tsx --env-file=.env.local scripts/apply-migration.ts db/migrations/0002_triage_review.sql
 */

import postgres from "postgres";
import { readFileSync } from "fs";

const file = process.argv[2];
if (!file) { console.error("usage: apply-migration <path-to-sql>"); process.exit(1); }
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(1); }

const sql = readFileSync(file, "utf-8");
const stmts = sql
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter((s) => s.length > 0 && !s.split("\n").every((l) => l.trim().startsWith("--") || !l.trim()));

async function main() {
  console.log(`Applying ${stmts.length} statements from ${file}...`);
  const pg = postgres(DATABASE_URL!, { max: 1 });
  try {
    for (let i = 0; i < stmts.length; i++) {
      const preview = stmts[i].split("\n")[0].slice(0, 80);
      process.stdout.write(`  [${i + 1}/${stmts.length}] ${preview}…`);
      await pg.unsafe(stmts[i]);
      console.log(" ok");
    }
    console.log("Done.");
  } catch (e) {
    console.error("\nMigration failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    await pg.end();
  }
}

main();
