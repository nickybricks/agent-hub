/**
 * Onboarding status for the client: whether the signed-in user still needs the
 * onboarding chat flow (no `user_profile` memory yet) and whether their mailbox
 * is connected. Used by the /app shell to auto-start onboarding and by the
 * /onboarding redirect page.
 */

import { NextResponse } from "next/server";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { onboardingState } from "@/lib/chat-agent";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isMultiTenant()) {
    return NextResponse.json({ onboarded: true, connected: true });
  }
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const s = await onboardingState(user.id);
  return NextResponse.json({ onboarded: !s.active, connected: s.connected });
}
