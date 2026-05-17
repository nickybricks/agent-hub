import { spawnSync } from "child_process";
import { createMailProvider, type MailboxInfo, type MailMessage } from "../lib/mail-provider";
import { isMultiTenant } from "../lib/db";
import {
  upsertMailbox as upsertMailboxSqlite,
  upsertMessages as upsertMessagesSqlite,
  getWatermark as getWatermarkSqlite,
  startScanRun as startScanRunSqlite,
  finishScanRun as finishScanRunSqlite,
  failScanRun as failScanRunSqlite,
  updateScanProgress as updateScanProgressSqlite,
} from "../lib/analyzer-db";
import {
  upsertMailboxPg,
  upsertMessagesPg,
  getWatermarkPg,
  startScanRunPg,
  finishScanRunPg,
  failScanRunPg,
  updateScanProgressPg,
} from "../lib/analyzer-db-pg";

const MT = isMultiTenant();

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
 * Run a full mailbox scan. In multi-tenant mode `userId` is required and
 * credentials/storage are scoped to that user; in single-user mode pass
 * undefined and SQLite + config.json are used.
 */
export async function runScan(
  userId: string | undefined,
  opts: { rescanHeaders?: boolean } = {},
): Promise<ScanResult> {
  if (MT && !userId) throw new Error("MULTI_TENANT=true requires a userId");

  // Per-user dispatchers — closures over userId so concurrent runs stay isolated.
  const upsertMailbox = (info: MailboxInfo): Promise<number> =>
    MT ? upsertMailboxPg(userId!, info) : Promise.resolve(upsertMailboxSqlite(info));
  const upsertMessages = async (chunk: MailMessage[], mailboxId: number): Promise<void> => {
    if (MT) await upsertMessagesPg(userId!, chunk, mailboxId);
    else upsertMessagesSqlite(chunk, mailboxId);
  };
  const getWatermark = (name: string, account: string): Promise<string | null> =>
    MT ? getWatermarkPg(userId!, name, account) : Promise.resolve(getWatermarkSqlite(name, account));
  const startScanRun = (): Promise<number> =>
    MT ? startScanRunPg(userId!) : Promise.resolve(startScanRunSqlite());
  const updateScanProgress = async (id: number, scanned: number): Promise<void> => {
    if (MT) await updateScanProgressPg(userId!, id, scanned);
    else updateScanProgressSqlite(id, scanned);
  };
  const finishScanRun = async (id: number, scanned: number, watermark: string | null): Promise<void> => {
    if (MT) await finishScanRunPg(userId!, id, scanned, watermark);
    else finishScanRunSqlite(id, scanned, watermark);
  };
  const failScanRun = async (id: number, error: string): Promise<void> => {
    if (MT) await failScanRunPg(userId!, id, error);
    else failScanRunSqlite(id, error);
  };

  const rescanHeaders = !!opts.rescanHeaders;
  console.log(`Starting mailbox analysis via IMAP...${rescanHeaders ? " (rescan-headers: ignoring watermark)" : ""}`);

  const session = await createMailProvider(MT ? userId : undefined);
  let allMailboxes;
  try {
    await session.open();
    allMailboxes = (await session.listMailboxes()).filter((mb) => !shouldSkip(mb.name));
  } catch (err) {
    await session.close().catch(() => {});
    throw new Error(`Failed to connect / list mailboxes: ${err instanceof Error ? err.message : err}`);
  }

  console.log(`Connected. Found ${allMailboxes.length} mailboxes to scan.`);

  const runId = await startScanRun();
  let totalScanned = 0;
  let latestDate: string | null = null;

  try {
    for (const mbInfo of allMailboxes) {
      const watermark = rescanHeaders ? null : await getWatermark(mbInfo.name, mbInfo.account);
      console.log(
        `Scanning "${mbInfo.name}" (${mbInfo.messageCount} messages${watermark ? `, since ${watermark}` : ", full scan"})`
      );

      const mailboxId = await upsertMailbox(mbInfo);

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
            await upsertMessages(chunk, mailboxId);
            await updateScanProgress(runId, scannedAt);
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

    await finishScanRun(runId, totalScanned, latestDate);
    console.log(`\nDone. ${totalScanned} messages scanned/updated.`);
    if (latestDate) console.log(`Watermark: ${latestDate}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failScanRun(runId, msg);
    throw new Error(`Scan failed: ${msg}`);
  } finally {
    await session.close();
  }

  return { runId, scanned: totalScanned, watermark: latestDate };
}

// CLI entry — only run when invoked directly.
if (require.main === module) {
  (async () => {
    const userId = MT ? process.env.DEV_USER_ID : undefined;
    if (MT && !userId) {
      console.error("MULTI_TENANT=true requires DEV_USER_ID env var.");
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
