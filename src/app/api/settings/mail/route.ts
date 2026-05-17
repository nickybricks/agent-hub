import { NextResponse } from "next/server";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { isMultiTenant } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";
import { getMailCredentials, saveMailCredentials } from "@/lib/credentials";
import type { MailConfig } from "@/lib/mail-provider";

const CONFIG_PATH = join(process.cwd(), "data", "config.json");

// ── local-dev helpers ────────────────────────────────────────────────────────

function readFull(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

function writeFull(obj: Record<string, unknown>): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2));
}

function redactSecrets(mail: MailConfig | undefined, status?: Record<string, boolean>): MailConfig & { _status: Record<string, boolean> } {
  const m = mail ?? {};
  return {
    provider: m.provider ?? "imap",
    imap: m.imap ? { host: m.imap.host, port: m.imap.port, user: m.imap.user, password: undefined } : undefined,
    gmail: m.gmail ? { clientId: m.gmail.clientId, clientSecret: m.gmail.clientSecret ? "" : undefined, refreshToken: undefined } : undefined,
    outlook: m.outlook
      ? { clientId: m.outlook.clientId, clientSecret: m.outlook.clientSecret ? "" : undefined, tenantId: m.outlook.tenantId, refreshToken: undefined }
      : undefined,
    _status: status ?? {
      imapPassword: !!(process.env.IMAP_PASSWORD || m.imap?.password),
      googleRefreshToken: !!(process.env.GOOGLE_REFRESH_TOKEN || m.gmail?.refreshToken),
      microsoftRefreshToken: !!(process.env.MS_REFRESH_TOKEN || m.outlook?.refreshToken),
    },
  };
}

// ── route handlers ───────────────────────────────────────────────────────────

export async function GET() {
  if (isMultiTenant()) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const cfg = await getMailCredentials(user.id);
    return NextResponse.json(redactSecrets(cfg, {
      imapPassword: !!cfg.imap?.password,
      googleRefreshToken: !!cfg.gmail?.refreshToken,
      microsoftRefreshToken: !!cfg.outlook?.refreshToken,
    }));
  }

  const full = readFull();
  return NextResponse.json(redactSecrets(full.mail as MailConfig | undefined));
}

export async function PUT(request: Request) {
  const body = (await request.json()) as MailConfig;

  if (isMultiTenant()) {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    // Read existing to preserve unset secrets.
    const existing = await getMailCredentials(user.id);
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

    await saveMailCredentials(user.id, merged);
    return NextResponse.json(redactSecrets(merged, {
      imapPassword: !!merged.imap?.password,
      googleRefreshToken: !!merged.gmail?.refreshToken,
      microsoftRefreshToken: !!merged.outlook?.refreshToken,
    }));
  }

  // Local dev: write to config.json
  const full = readFull();
  const existing = (full.mail as MailConfig | undefined) ?? {};
  const merged: MailConfig = {
    provider: body.provider ?? existing.provider ?? "imap",
    imap: {
      host: body.imap?.host ?? existing.imap?.host,
      port: body.imap?.port ?? existing.imap?.port,
      user: body.imap?.user ?? existing.imap?.user,
      password: body.imap?.password || existing.imap?.password,
    },
    gmail: {
      clientId: body.gmail?.clientId ?? existing.gmail?.clientId,
      clientSecret: body.gmail?.clientSecret || existing.gmail?.clientSecret,
      refreshToken: existing.gmail?.refreshToken,
    },
    outlook: {
      clientId: body.outlook?.clientId ?? existing.outlook?.clientId,
      clientSecret: body.outlook?.clientSecret || existing.outlook?.clientSecret,
      tenantId: body.outlook?.tenantId ?? existing.outlook?.tenantId,
      refreshToken: existing.outlook?.refreshToken,
    },
  };
  full.mail = merged;
  writeFull(full);
  return NextResponse.json(redactSecrets(merged));
}
