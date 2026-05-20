import { spawnSync } from "child_process";
import { createMailProvider } from "../lib/mail-provider";
import {
  upsertMailboxPg,
  upsertMessagesPg,
  getWatermarkPg,
  startScanRunPg,
  finishScanRunPg,
  failScanRunPg,
  updateScanProgressPg,
} from "../lib/analyzer-db-pg";

// Skip server-side folders that aren't useful for analysis.
const SKIP_PATTERNS = [/^Drafts$/i, /^Trash$/i, /^Deleted/i, /^Outbox$/i];

function shouldSkip(name: string): boolean {
  return SKIP_PATTERNS.some((re) => re.test(name));
}

export interface ScanResult {
  runId: number;
  scanned: number;
  watermark: string | null;
}

/**
 * Run a full mailbox scan for a given tenant.
 */
export async function runScan(
  userId: string,
  opts: { rescanHeaders?: boolean } = {},
): Promise<ScanResult> {
  const rescanHeaders = !!opts.rescanHeaders;
  console.log(`Starting mailbox analysis via IMAP...${rescanHeaders ? " (rescan-headers: ignoring watermark)" : ""}`);

  const session = await createMailProvider(userId);
  let allMailboxes;
  try {
    await session.open();
    allMailboxes = (await session.listMailboxes()).filter((mb) => !shouldSkip(mb.name));
  } catch (err) {
    await session.close().catch(() => {});
    throw new Error(`Failed to connect / list mailboxes: ${err instanceof Error ? err.message : err}`);
  }

  console.log(`Connected. Found ${allMailboxes.length} mailboxes to scan.`);

  const runId = await startScanRunPg(userId);
  let totalScanned = 0;
  let latestDate: string | null = null;

  try {
    for (const mbInfo of allMailboxes) {
      const watermark = rescanHeaders ? null : await getWatermarkPg(userId, mbInfo.name, mbInfo.account);
      console.log(
        `Scanning "${mbInfo.name}" (${mbInfo.messageCount} messages${watermark ? `, since ${watermark}` : ", full scan"})`
      );

      const mailboxId = await upsertMailboxPg(userId, mbInfo);

      // onChunk is invoked synchronously by the provider, so serialize the
      // (possibly async) Postgres writes onto a chain and await it after.
      let writeChain: Promise<void> = Promise.resolve();
      const count = await session.scanMailbox(
        mbInfo.account,
        mbInfo.name,
        watermark ?? undefined,
        (chunk, totalSoFar) => {
          const mbLatest = chunk[chunk.length - 1].dateReceived;
          if (!latestDate || mbLatest > latestDate) latestDate = mbLatest;
          const scannedAt = totalScanned + totalSoFar;
          writeChain = writeChain.then(async () => {
            await upsertMessagesPg(userId, chunk, mailboxId);
            await updateScanProgressPg(userId, runId, scannedAt);
            console.log(`  ...${totalSoFar} messages saved`);
          });
        }
      );
      await writeChain;

      if (count > 0) {
        console.log(`  Done. ${count} messages.`);
        totalScanned += count;
      } else {
        console.log("  No new messages");
      }
    }

    await finishScanRunPg(userId, runId, totalScanned, latestDate);
    console.log(`\nDone. ${totalScanned} messages scanned/updated.`);
    if (latestDate) console.log(`Watermark: ${latestDate}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failScanRunPg(userId, runId, msg);
    throw new Error(`Scan failed: ${msg}`);
  } finally {
    await session.close();
  }

  return { runId, scanned: totalScanned, watermark: latestDate };
}

// CLI entry — only run when invoked directly.
if (require.main === module) {
  (async () => {
    const userId = process.env.DEV_USER_ID;
    if (!userId) {
      console.error("DEV_USER_ID env var required.");
      process.exit(1);
    }
    try {
      await runScan(userId, { rescanHeaders: process.argv.includes("--rescan-headers") });
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
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
  })();
}
