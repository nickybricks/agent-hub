import { NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth";
import { getMailCredentials, saveMailCredentials } from "@/lib/credentials";
import type { MailConfig } from "@/lib/mail-provider";

function redactSecrets(
  mail: MailConfig | undefined,
  status: Record<string, boolean>,
): MailConfig & { _status: Record<string, boolean> } {
  const m = mail ?? {};
  return {
    provider: m.provider ?? "imap",
    imap: m.imap ? { host: m.imap.host, port: m.imap.port, user: m.imap.user, password: undefined } : undefined,
    gmail: m.gmail
      ? { clientId: m.gmail.clientId, clientSecret: m.gmail.clientSecret ? "" : undefined, refreshToken: undefined }
      : undefined,
    outlook: m.outlook
      ? {
          clientId: m.outlook.clientId,
          clientSecret: m.outlook.clientSecret ? "" : undefined,
          tenantId: m.outlook.tenantId,
          refreshToken: undefined,
        }
      : undefined,
    _status: status,
  };
}

export async function GET() {
  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const cfg = await getMailCredentials(auth.userId);
  return NextResponse.json(
    redactSecrets(cfg, {
      imapPassword: !!cfg.imap?.password,
      googleRefreshToken: !!cfg.gmail?.refreshToken,
      microsoftRefreshToken: !!cfg.outlook?.refreshToken,
    }),
  );
}

export async function PUT(request: Request) {
  const body = (await request.json()) as MailConfig;

  const auth = await getAuthUser();
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const userId = auth.userId;

  // Read existing to preserve unset secrets.
  const existing = await getMailCredentials(userId);
  const merged: MailConfig = {
    provider: body.provider ?? existing.provider ?? "imap",
    imap: {
      host: body.imap?.host ?? existing.imap?.host,
      port: body.imap?.port ?? existing.imap?.port,
      user: body.imap?.user ?? existing.imap?.user,
      password: body.imap?.password || existing.imap?.password,
    },
    gmail: {
      clientId: existing.gmail?.clientId,
      clientSecret: existing.gmail?.clientSecret,
      refreshToken: existing.gmail?.refreshToken,
    },
    outlook: {
      clientId: existing.outlook?.clientId,
      clientSecret: existing.outlook?.clientSecret,
      tenantId: body.outlook?.tenantId ?? existing.outlook?.tenantId,
      refreshToken: existing.outlook?.refreshToken,
    },
  };

  await saveMailCredentials(userId, merged);
  return NextResponse.json(
    redactSecrets(merged, {
      imapPassword: !!merged.imap?.password,
      googleRefreshToken: !!merged.gmail?.refreshToken,
      microsoftRefreshToken: !!merged.outlook?.refreshToken,
    }),
  );
}
