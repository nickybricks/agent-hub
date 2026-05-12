import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { openSync, mkdirSync } from "fs";
import { join } from "path";
import { findInProgressScan } from "@/lib/analyzer-db";

export const dynamic = "force-dynamic";

export async function POST() {
  const existing = findInProgressScan();
  if (existing) {
    return NextResponse.json(
      { error: "Scan already in progress", id: existing.id },
      { status: 409 }
    );
  }

  const cwd = process.cwd();
  mkdirSync(join(cwd, "logs"), { recursive: true });
  const logPath = join(cwd, "logs", "mail-analyzer.log");
  const out = openSync(logPath, "a");
  const err = openSync(logPath, "a");

  const child = spawn("npm", ["run", "mail:analyze"], {
    cwd,
    detached: true,
    stdio: ["ignore", out, err],
    env: process.env,
  });
  child.unref();

  return NextResponse.json({ ok: true, pid: child.pid });
}
