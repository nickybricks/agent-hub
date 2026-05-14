import { NextResponse } from "next/server";
import { readMailConfig } from "@/lib/mail-provider";
import { upsertEnvVars } from "@/lib/env-file";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (error) return NextResponse.json({ error }, { status: 400 });
  if (!code) return NextResponse.json({ error: "Missing code" }, { status: 400 });

  const cfg = readMailConfig();
  const clientId = process.env.MS_CLIENT_ID ?? cfg.outlook?.clientId;
  const clientSecret = process.env.MS_CLIENT_SECRET ?? cfg.outlook?.clientSecret;
  const tenantId = process.env.MS_TENANT_ID ?? cfg.outlook?.tenantId ?? "common";
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: "Missing Microsoft client credentials" }, { status: 400 });
  }

  const redirectUri = `${url.origin}/api/auth/microsoft/callback`;
  const tokenRes = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        scope: "offline_access https://graph.microsoft.com/Mail.ReadWrite",
      }),
    }
  );
  if (!tokenRes.ok) {
    return NextResponse.json({ error: await tokenRes.text() }, { status: 400 });
  }
  const tokens = (await tokenRes.json()) as { refresh_token?: string };
  if (!tokens.refresh_token) {
    return NextResponse.json({ error: "Microsoft did not return a refresh_token." }, { status: 400 });
  }

  upsertEnvVars({ MS_REFRESH_TOKEN: tokens.refresh_token });

  return NextResponse.redirect(`${url.origin}/settings/mail?connected=outlook`);
}
