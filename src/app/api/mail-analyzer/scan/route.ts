import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { openSync, mkdirSync } from "fs";
import { join } from "path";
import { findInProgressScan } from "@/lib/analyzer-db";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { findInProgressScanPg } from "@/lib/analyzer-db-pg";

export const dynamic = "force-dynamic";

export async function POST() {
  let existing: { id: number } | null;
  if (isMultiTenant()) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    existing = await findInProgressScanPg(user.id);
  } else {
    existing = findInProgressScan();
  }
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
