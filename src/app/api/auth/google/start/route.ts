import { NextResponse } from "next/server";
import { readMailConfig } from "@/lib/mail-provider";

export async function GET(request: Request) {
  const cfg = readMailConfig();
  const clientId = process.env.GOOGLE_CLIENT_ID ?? cfg.gmail?.clientId;
  if (!clientId) {
    return NextResponse.json(
      { error: "Missing GOOGLE_CLIENT_ID. Configure it on the Mail settings page first." },
      { status: 400 }
    );
  }
  const origin = new URL(request.url).origin;
  const redirectUri = `${origin}/api/auth/google/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    // gmail.modify covers read + label create + message label modify (move).
    // It does NOT allow permanent deletion (which would need gmail.full).
    scope: "https://www.googleapis.com/auth/gmail.modify",
  });
  return NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}
