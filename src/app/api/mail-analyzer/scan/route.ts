import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { findInProgressScanPg } from "@/lib/analyzer-db-pg";
import { inngest } from "@/inngest/client";

export const dynamic = "force-dynamic";

export async function POST() {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = auth.userId;

  const existing = await findInProgressScanPg(userId);
  if (existing) {
    return NextResponse.json(
      { error: "Scan already in progress", id: existing.id },
      { status: 409 }
    );
  }

  await inngest.send({ name: "mail/scan", data: { userId } });

  return NextResponse.json({ ok: true });
}
