#!/usr/bin/env -S npx tsx
/**
 * Auto-trigger poller for the Engineer workflow.
 *
 * Runs on a GH Actions cron. Picks one Notion card in "working on it"
 * status and prints its id to stdout for the calling workflow to dispatch
 * the Engineer with. Skips if any engineer.yml run is already in-flight,
 * so at most one Engineer runs at a time globally.
 *
 * Exit codes:
 *   0 — normal exit. stdout is either empty (nothing to do) or a card_id.
 *   1 — config / API error.
 *
 * Required env: NOTION_TOKEN, NOTION_BACKLOG_DB_ID, GH_TOKEN, GH_REPO
 *   (GH_REPO in "owner/name" form; in Actions, default to GITHUB_REPOSITORY).
 */

import { listBacklog } from "./backlog";

const GH_API = "https://api.github.com";

async function engineerBusy(): Promise<boolean> {
  const token = process.env.GH_TOKEN;
  const repo = process.env.GH_REPO ?? process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    throw new Error("GH_TOKEN and GH_REPO (or GITHUB_REPOSITORY) must be set");
  }
  // Query the engineer workflow's recent runs in non-terminal states.
  const url = `${GH_API}/repos/${repo}/actions/workflows/engineer.yml/runs?per_page=20`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GH API ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    workflow_runs: { status: string }[];
  };
  const ACTIVE = new Set(["in_progress", "queued", "requested", "waiting", "pending"]);
  return data.workflow_runs.some((r) => ACTIVE.has(r.status));
}

async function main() {
  if (await engineerBusy()) {
    // Stay silent on stdout so the workflow knows there's nothing to dispatch.
    console.error("engineer busy — skipping poll");
    return;
  }
  const working = await listBacklog("working on it");
  if (working.length === 0) {
    console.error("no cards in 'working on it' — nothing to dispatch");
    return;
  }
  // FIFO-ish: Notion doesn't expose status-change time, so we use the
  // current order of the API response. Good enough for a single-user board.
  const target = working[0];
  console.error(`dispatching engineer for: ${target.title} (${target.id})`);
  process.stdout.write(target.id);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
