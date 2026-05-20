/**
 * Onboarding status for the client: whether the signed-in user still needs the
 * onboarding chat flow (no `user_profile` memory yet) and whether their mailbox
 * is connected. Used by the /app shell to auto-start onboarding and by the
 * /onboarding redirect page.
 */

import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { onboardingState } from "@/lib/chat-agent";
import { describeError } from "@/lib/errcause";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const s = await onboardingState(auth.userId);
    return NextResponse.json({ onboarded: !s.active, connected: s.connected });
  } catch (e) {
    console.error("onboarding/status error", e);
    return NextResponse.json(
      { error: describeError(e), onboarded: true, connected: false },
      { status: 200 },
    );
  }
}
