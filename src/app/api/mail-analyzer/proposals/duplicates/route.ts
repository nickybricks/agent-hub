/**
 * Surfaces near-duplicate real folders so the user can spot the mess an earlier
 * double-onboarding created. Read-only suggestion (no automated merge moves).
 */

import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { findDuplicateFolders } from "@/lib/folder-duplicates";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const clusters = await findDuplicateFolders(auth.userId);
    return NextResponse.json({ clusters });
  } catch (e) {
    console.error("duplicates route error", e);
    return NextResponse.json({ clusters: [] });
  }
}
