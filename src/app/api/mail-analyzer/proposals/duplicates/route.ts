/**
 * Surfaces near-duplicate real folders so the user can spot the mess an earlier
 * double-onboarding created. Read-only suggestion (no automated merge moves).
 * Multi-tenant only; returns an empty list otherwise.
 */

import { NextResponse } from "next/server";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { findDuplicateFolders } from "@/lib/folder-duplicates";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  if (!isMultiTenant()) return NextResponse.json({ clusters: [] });

  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const clusters = await findDuplicateFolders(user.id);
    return NextResponse.json({ clusters });
  } catch (e) {
    console.error("duplicates route error", e);
    return NextResponse.json({ clusters: [] });
  }
}
