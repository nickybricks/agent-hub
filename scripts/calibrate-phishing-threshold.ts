/**
 * Phishing-threshold calibration.
 *
 * Re-scores every sender at the current threshold (0.5) and at a proposed
 * threshold (default 0.4), then reports counts + diffs so we can see how many
 * NEW findings a threshold drop would produce on real data before flipping it.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/calibrate-phishing-threshold.ts
 *   npx tsx --env-file=.env.local scripts/calibrate-phishing-threshold.ts --proposed=0.4
 */
import { aggregate, scorePhishingRisk, SenderAgg } from "../src/agent/audit";
import { loadAllMessagesPg } from "../src/lib/analyzer-db-pg";

function parseArg(name: string, fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return fallback;
  const v = Number(arg.split("=")[1]);
  if (Number.isNaN(v)) throw new Error(`bad value for --${name}`);
  return v;
}

function fmt(s: SenderAgg, score: number, reasons: string[]): string {
  return `  ${score.toFixed(2)}  ${s.email.padEnd(50)}  ${reasons.join("; ")}`;
}

async function main() {
  const current = parseArg("current", 0.5);
  const proposed = parseArg("proposed", 0.4);
  console.log(`Calibrating phishing threshold: current=${current} vs proposed=${proposed}\n`);

  const userId = process.env.DEV_USER_ID;
  if (!userId) throw new Error("DEV_USER_ID env var required.");
  const rows = await loadAllMessagesPg(userId);
  const senders = aggregate(rows);
  console.log(`Loaded ${rows.length} messages across ${senders.size} senders.\n`);

  const currentHits: { s: SenderAgg; score: number; reasons: string[] }[] = [];
  const proposedHits: { s: SenderAgg; score: number; reasons: string[] }[] = [];

  for (const s of senders.values()) {
    const cur = scorePhishingRisk(s, current);
    if (cur) currentHits.push({ s, score: cur.score, reasons: cur.reasons });
    const prop = scorePhishingRisk(s, proposed);
    if (prop) proposedHits.push({ s, score: prop.score, reasons: prop.reasons });
  }

  const currentEmails = new Set(currentHits.map((h) => h.s.email));
  const proposedEmails = new Set(proposedHits.map((h) => h.s.email));

  const newOnly = proposedHits.filter((h) => !currentEmails.has(h.s.email));
  const lost = currentHits.filter((h) => !proposedEmails.has(h.s.email));

  console.log(`Current threshold (${current}): ${currentHits.length} findings`);
  console.log(`Proposed threshold (${proposed}): ${proposedHits.length} findings`);
  console.log(`Net new findings: ${newOnly.length}`);
  console.log(`Findings lost: ${lost.length} (should be 0 if proposed < current)\n`);

  if (newOnly.length > 0) {
    console.log(`--- NEW findings (sample up to 50) ---`);
    for (const h of newOnly.slice(0, 50)) console.log(fmt(h.s, h.score, h.reasons));
    if (newOnly.length > 50) console.log(`  ... ${newOnly.length - 50} more`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
