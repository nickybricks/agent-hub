import { NextResponse } from "next/server";
import { findInProgressScan } from "@/lib/analyzer-db";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { findInProgressScanPg } from "@/lib/analyzer-db-pg";
import { inngest } from "@/inngest/client";

export const dynamic = "force-dynamic";

export async function POST() {
  let userId: string | undefined;
  let existing: { id: number } | null;

  if (isMultiTenant()) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    userId = user.id;
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

  await inngest.send({ name: "mail/scan", data: { userId } });

  return NextResponse.json({ ok: true });
}
