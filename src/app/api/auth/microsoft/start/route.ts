import { NextResponse } from "next/server";
import { readMailConfig } from "@/lib/mail-provider";
import { createPkcePair, attachPkceCookie } from "@/lib/oauth-pkce";

export async function GET(request: Request) {
  const cfg = readMailConfig();
  const clientId = process.env.MS_CLIENT_ID ?? cfg.outlook?.clientId;
  const tenantId = process.env.MS_TENANT_ID ?? cfg.outlook?.tenantId ?? "common";
  if (!clientId) {
    return NextResponse.json(
      { error: "Missing MS_CLIENT_ID. Configure it on the Mail settings page first." },
      { status: 400 }
    );
  }
  const origin = new URL(request.url).origin;
  const redirectUri = `${origin}/api/auth/microsoft/callback`;
  const { state, codeVerifier, codeChallenge } = createPkcePair();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: "offline_access https://graph.microsoft.com/Mail.ReadWrite",
    prompt: "consent",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  const response = NextResponse.redirect(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params}`
  );
  attachPkceCookie(response, state, codeVerifier);
  return response;
}
