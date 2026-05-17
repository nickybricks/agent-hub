import { getDrizzleDb } from "@/lib/db";
import { userSettings } from "../../db/schema";
import { eq } from "drizzle-orm";
import { getServiceClient } from "@/lib/supabase/service";
import type { MailConfig } from "@/lib/mail-provider";

// Supabase client typed as any for custom vault RPCs not in generated schema.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SvcClient = any;

function secretName(userId: string, key: string) {
  return `mail:${userId}:${key}`;
}

export async function getMailCredentials(userId: string): Promise<MailConfig> {
  const db = getDrizzleDb();
  const svc: SvcClient = getServiceClient();

  const [settingsRows, imapPw, googleToken, msToken] = await Promise.all([
    db.select().from(userSettings).where(eq(userSettings.userId, userId)).limit(1),
    svc.rpc("get_vault_secret", { p_name: secretName(userId, "imap_password") }),
    svc.rpc("get_vault_secret", { p_name: secretName(userId, "google_refresh_token") }),
    svc.rpc("get_vault_secret", { p_name: secretName(userId, "ms_refresh_token") }),
  ]);

  const cfg = settingsRows[0];

  return {
    provider: (cfg?.provider as MailConfig["provider"]) ?? "imap",
    imap: {
      host: cfg?.imapHost ?? undefined,
      port: cfg?.imapPort ?? undefined,
      user: cfg?.imapUser ?? undefined,
      password: (imapPw.data as string | null) ?? undefined,
    },
    gmail: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      refreshToken: (googleToken.data as string | null) ?? undefined,
    },
    outlook: {
      clientId: process.env.MS_CLIENT_ID,
      clientSecret: process.env.MS_CLIENT_SECRET,
      tenantId: process.env.MS_TENANT_ID,
      refreshToken: (msToken.data as string | null) ?? undefined,
    },
  };
}

export async function saveMailCredentials(userId: string, config: MailConfig): Promise<void> {
  const db = getDrizzleDb();
  const svc: SvcClient = getServiceClient();
  const now = new Date().toISOString();

  await db
    .insert(userSettings)
    .values({
      userId,
      provider: config.provider ?? "imap",
      imapHost: config.imap?.host ?? null,
      imapPort: config.imap?.port ?? null,
      imapUser: config.imap?.user ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: {
        provider: config.provider ?? "imap",
        imapHost: config.imap?.host ?? null,
        imapPort: config.imap?.port ?? null,
        imapUser: config.imap?.user ?? null,
        updatedAt: now,
      },
    });

  const writes: Promise<unknown>[] = [];
  if (config.imap?.password) {
    writes.push(
      svc.rpc("upsert_vault_secret", {
        p_name: secretName(userId, "imap_password"),
        p_value: config.imap.password,
      })
    );
  }
  if (config.gmail?.refreshToken) {
    writes.push(
      svc.rpc("upsert_vault_secret", {
        p_name: secretName(userId, "google_refresh_token"),
        p_value: config.gmail.refreshToken,
      })
    );
  }
  if (config.outlook?.refreshToken) {
    writes.push(
      svc.rpc("upsert_vault_secret", {
        p_name: secretName(userId, "ms_refresh_token"),
        p_value: config.outlook.refreshToken,
      })
    );
  }
  await Promise.all(writes);
}

export async function saveVaultSecret(userId: string, key: string, value: string): Promise<void> {
  const svc: SvcClient = getServiceClient();
  await svc.rpc("upsert_vault_secret", {
    p_name: secretName(userId, key),
    p_value: value,
  });
}
