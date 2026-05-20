import { NextResponse } from "next/server";
import { readPkceCookie, clearPkceCookie } from "@/lib/oauth-pkce";
import { getAuthUser } from "@/lib/auth";
import { saveVaultSecret } from "@/lib/credentials";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const stateFromQuery = url.searchParams.get("state");
  if (error) return NextResponse.json({ error }, { status: 400 });
  if (!code) return NextResponse.json({ error: "Missing code" }, { status: 400 });

  const pkce = await readPkceCookie();
  if (!pkce || !stateFromQuery || pkce.state !== stateFromQuery) {
    return NextResponse.json({ error: "Invalid OAuth state" }, { status: 400 });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: "Missing Google client credentials" }, { status: 400 });
  }

  const redirectUri = `${url.origin}/api/auth/google/callback`;
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: pkce.codeVerifier,
    }),
  });
  if (!tokenRes.ok) {
    return NextResponse.json({ error: await tokenRes.text() }, { status: 400 });
  }
  const tokens = (await tokenRes.json()) as { refresh_token?: string };
  if (!tokens.refresh_token) {
    return NextResponse.json(
      { error: "Google did not return a refresh_token. Revoke prior consent at myaccount.google.com/permissions and retry." },
      { status: 400 }
    );
  }

  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await saveVaultSecret(auth.userId, "google_refresh_token", tokens.refresh_token);

  const response = NextResponse.redirect(`${url.origin}/settings/mail?connected=gmail`);
  clearPkceCookie(response);
  return response;
}
