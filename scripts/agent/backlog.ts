#!/usr/bin/env -S npx tsx
/**
 * Notion backlog adapter for the agent team flow.
 *
 * The Notion kanban (DB env: NOTION_BACKLOG_DB_ID) is the source of truth.
 * Status column values: "Backlog" | "working on it" | "Review" | "Done"
 *
 * CLI usage:
 *   npx tsx scripts/agent/backlog.ts list
 *   npx tsx scripts/agent/backlog.ts next            # top of Backlog by priority
 *   npx tsx scripts/agent/backlog.ts claim <pageId>  # → "working on it"
 *   npx tsx scripts/agent/backlog.ts review <pageId> --pr=<url>
 *   npx tsx scripts/agent/backlog.ts done <pageId>
 *   npx tsx scripts/agent/backlog.ts show <pageId>
 *
 * Library usage:
 *   import { listBacklog, pickNext, claim, sendToReview, markDone } from "./backlog";
 */

const NOTION_VERSION = "2022-06-28";
const STATUS = {
  backlog: "Backlog",
  working: "working on it",
  review: "Review",
  done: "Done",
} as const;

const PRIORITY_ORDER: Record<string, number> = { Hoch: 0, Mittel: 1, Niedrig: 2 };

function env() {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_BACKLOG_DB_ID;
  if (!token || !dbId) {
    throw new Error("NOTION_TOKEN and NOTION_BACKLOG_DB_ID must be set in .env.local");
  }
  return { token, dbId };
}

async function notion(path: string, init: RequestInit = {}) {
  const { token } = env();
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Notion API ${res.status} ${path}: ${await res.text()}`);
  }
  return res.json();
}

export interface BacklogItem {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  description: string;
  url: string;
}

type NotionRichText = { plain_text: string };
type NotionPage = {
  id: string;
  url: string;
  properties?: {
    Task?: { title?: NotionRichText[] };
    Status?: { status?: { name?: string } };
    Priority?: { select?: { name?: string } };
    Description?: { rich_text?: NotionRichText[] };
  };
};

function extractItem(page: NotionPage): BacklogItem {
  const props = page.properties ?? {};
  const title = (props.Task?.title ?? []).map((t) => t.plain_text).join("") || "(untitled)";
  const status = props.Status?.status?.name ?? "";
  const priority = props.Priority?.select?.name ?? null;
  const description = (props.Description?.rich_text ?? [])
    .map((t) => t.plain_text)
    .join("");
  return { id: page.id, title, status, priority, description, url: page.url };
}

export async function listBacklog(statusFilter?: string): Promise<BacklogItem[]> {
  const { dbId } = env();
  const body: { page_size: number; filter?: unknown } = { page_size: 100 };
  if (statusFilter) {
    body.filter = { property: "Status", status: { equals: statusFilter } };
  }
  const data = (await notion(`/databases/${dbId}/query`, {
    method: "POST",
    body: JSON.stringify(body),
  })) as { results: NotionPage[] };
  return data.results.map(extractItem);
}

export async function pickNext(): Promise<BacklogItem | null> {
  const items = await listBacklog(STATUS.backlog);
  if (items.length === 0) return null;
  items.sort(
    (a, b) =>
      (PRIORITY_ORDER[a.priority ?? ""] ?? 99) - (PRIORITY_ORDER[b.priority ?? ""] ?? 99),
  );
  return items[0];
}

async function setStatus(pageId: string, status: string) {
  await notion(`/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: { Status: { status: { name: status } } } }),
  });
}

async function addComment(pageId: string, text: string) {
  await notion(`/comments`, {
    method: "POST",
    body: JSON.stringify({
      parent: { page_id: pageId },
      rich_text: [{ type: "text", text: { content: text } }],
    }),
  });
}

export async function claim(pageId: string) {
  await setStatus(pageId, STATUS.working);
}

export async function sendToReview(pageId: string, prUrl: string) {
  await setStatus(pageId, STATUS.review);
  // Comment is decorative — the status change is what matters. Tolerate
  // integrations missing the "Insert content" capability so the run still
  // counts as a success.
  try {
    await addComment(pageId, `PR ready for review: ${prUrl}`);
  } catch (e) {
    console.warn(`addComment failed (non-fatal): ${(e as Error).message}`);
  }
}

export async function markDone(pageId: string) {
  await setStatus(pageId, STATUS.done);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = Object.fromEntries(
    rest.filter((a) => a.startsWith("--")).map((a) => {
      const [k, v] = a.slice(2).split("=");
      return [k, v ?? "true"];
    }),
  );
  const positional = rest.filter((a) => !a.startsWith("--"));

  const main = async () => {
    switch (cmd) {
      case "list": {
        const items = await listBacklog();
        for (const i of items) {
          console.log(`[${i.status.padEnd(14)}] ${(i.priority ?? "—").padEnd(8)} ${i.title}  (${i.id})`);
        }
        break;
      }
      case "next": {
        const item = await pickNext();
        if (!item) {
          console.log("(backlog empty)");
          return;
        }
        console.log(JSON.stringify(item, null, 2));
        break;
      }
      case "show": {
        const id = positional[0];
        if (!id) throw new Error("usage: show <pageId>");
        const items = await listBacklog();
        const match = items.find((i) => i.id === id);
        console.log(JSON.stringify(match ?? null, null, 2));
        break;
      }
      case "claim": {
        const id = positional[0];
        if (!id) throw new Error("usage: claim <pageId>");
        await claim(id);
        console.log("claimed");
        break;
      }
      case "review": {
        const id = positional[0];
        if (!id) throw new Error("usage: review <pageId> --pr=<url>");
        if (!flags.pr) throw new Error("--pr=<url> required");
        await sendToReview(id, flags.pr);
        console.log("sent to review");
        break;
      }
      case "done": {
        const id = positional[0];
        if (!id) throw new Error("usage: done <pageId>");
        await markDone(id);
        console.log("done");
        break;
      }
      default:
        console.error("commands: list | next | show <id> | claim <id> | review <id> --pr=<url> | done <id>");
        process.exit(1);
    }
  };
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
