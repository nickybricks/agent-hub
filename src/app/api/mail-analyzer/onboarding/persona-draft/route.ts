/**
 * Synthesise a draft persona from the *completed* classified mailbox + the
 * questionnaire answers. The client calls this once when the pipeline reaches
 * `persona_ready`; it returns the draft to show in the editable confirm card.
 * Multi-tenant only.
 */

import { NextResponse } from "next/server";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { synthesizePersona } from "@/lib/onboarding";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST() {
  if (!isMultiTenant()) {
    return NextResponse.json({ error: "onboarding is multi-tenant only" }, { status: 400 });
  }
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const persona = await synthesizePersona(user.id);
  return NextResponse.json({ persona });
}
