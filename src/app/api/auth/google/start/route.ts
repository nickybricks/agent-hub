import { NextResponse } from "next/server";
import { createPkcePair, attachPkceCookie } from "@/lib/oauth-pkce";

export async function GET(request: Request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "Missing GOOGLE_CLIENT_ID. Configure it on the Mail settings page first." },
      { status: 400 }
    );
  }
  const origin = new URL(request.url).origin;
  const redirectUri = `${origin}/api/auth/google/callback`;
  const { state, codeVerifier, codeChallenge } = createPkcePair();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    // gmail.modify covers read + label create + message label modify (move).
    // It does NOT allow permanent deletion (which would need gmail.full).
    scope: "https://www.googleapis.com/auth/gmail.modify",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  const response = NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  attachPkceCookie(response, state, codeVerifier);
  return response;
}
