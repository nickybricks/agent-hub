import { spawnSync } from "child_process";
import { createMailProvider } from "../lib/mail-provider";
import {
  upsertMailbox,
  upsertMessages,
  getWatermark,
  startScanRun,
  finishScanRun,
  failScanRun,
  updateScanProgress,
} from "../lib/analyzer-db";

// Skip server-side folders that aren't useful for analysis.
const SKIP_PATTERNS = [/^Drafts$/i, /^Trash$/i, /^Deleted/i, /^Outbox$/i];

function shouldSkip(name: string): boolean {
  return SKIP_PATTERNS.some((re) => re.test(name));
}

async function main() {
  const rescanHeaders = process.argv.includes("--rescan-headers");
  console.log(`Starting mailbox analysis via IMAP...${rescanHeaders ? " (rescan-headers: ignoring watermark)" : ""}`);

  const session = await createMailProvider();
  let allMailboxes;
  try {
    await session.open();
    allMailboxes = (await session.listMailboxes()).filter((mb) => !shouldSkip(mb.name));
  } catch (err) {
    console.error("Failed to connect / list mailboxes:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  console.log(`Connected. Found ${allMailboxes.length} mailboxes to scan.`);

  const runId = startScanRun();
  let totalScanned = 0;
  let latestDate: string | null = null;

  try {
    for (const mbInfo of allMailboxes) {
      const watermark = rescanHeaders ? null : getWatermark(mbInfo.name, mbInfo.account);
      console.log(
        `Scanning "${mbInfo.name}" (${mbInfo.messageCount} messages${watermark ? `, since ${watermark}` : ", full scan"})`
      );

      const mailboxId = upsertMailbox(mbInfo);

      const count = await session.scanMailbox(
        mbInfo.account,
        mbInfo.name,
        watermark ?? undefined,
        (chunk, totalSoFar) => {
          upsertMessages(chunk, mailboxId);
          const mbLatest = chunk[chunk.length - 1].dateReceived;
          if (!latestDate || mbLatest > latestDate) latestDate = mbLatest;
          updateScanProgress(runId, totalScanned + totalSoFar);
          console.log(`  ...${totalSoFar} messages saved`);
        }
      );

      if (count > 0) {
        console.log(`  Done. ${count} messages.`);
        totalScanned += count;
      } else {
        console.log("  No new messages");
      }
    }

    finishScanRun(runId, totalScanned, latestDate);
    console.log(`\nDone. ${totalScanned} messages scanned/updated.`);
    if (latestDate) console.log(`Watermark: ${latestDate}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failScanRun(runId, msg);
    console.error("Scan failed:", msg);
    process.exit(1);
  } finally {
    await session.close();
  }

  if (process.argv.includes("--classify")) {
    console.log("\nRunning sender classification...");
    const res = spawnSync(
      "npx",
      ["tsx", "--env-file=.env.local", "src/agent/classify-senders.ts"],
      { stdio: "inherit" },
    );
    if (res.status !== 0) process.exit(res.status ?? 1);
  }
}

main();
