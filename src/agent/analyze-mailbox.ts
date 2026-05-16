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
const USER_ID = MT ? process.env.DEV_USER_ID : null;
if (MT && !USER_ID) {
  console.error("MULTI_TENANT=true requires DEV_USER_ID env var.");
  process.exit(1);
}

async function upsertMailbox(info: MailboxInfo): Promise<number> {
  return MT ? upsertMailboxPg(USER_ID!, info) : upsertMailboxSqlite(info);
}
async function upsertMessages(chunk: MailMessage[], mailboxId: number): Promise<void> {
  if (MT) await upsertMessagesPg(USER_ID!, chunk, mailboxId);
  else upsertMessagesSqlite(chunk, mailboxId);
}
async function getWatermark(name: string, account: string): Promise<string | null> {
  return MT ? getWatermarkPg(USER_ID!, name, account) : getWatermarkSqlite(name, account);
}
async function startScanRun(): Promise<number> {
  return MT ? startScanRunPg(USER_ID!) : startScanRunSqlite();
}
async function updateScanProgress(id: number, scanned: number): Promise<void> {
  if (MT) await updateScanProgressPg(USER_ID!, id, scanned);
  else updateScanProgressSqlite(id, scanned);
}
async function finishScanRun(id: number, scanned: number, watermark: string | null): Promise<void> {
  if (MT) await finishScanRunPg(USER_ID!, id, scanned, watermark);
  else finishScanRunSqlite(id, scanned, watermark);
}
async function failScanRun(id: number, error: string): Promise<void> {
  if (MT) await failScanRunPg(USER_ID!, id, error);
  else failScanRunSqlite(id, error);
}

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
