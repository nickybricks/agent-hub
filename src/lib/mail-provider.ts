import { readFileSync } from "fs";
import { join } from "path";

export interface MailboxInfo {
  name: string;
  account: string;
  messageCount: number;
  unreadCount: number;
}

export interface MailMessage {
  id: string;
  mailbox: string;
  account: string;
  senderEmail: string;
  senderName: string;
  subject: string;
  dateReceived: string;
  isRead: boolean;
  sizeBytes: number;
  headersJson?: string | null;
}

export interface RawMessage {
  uid: number;
  source: Buffer;
  isRead: boolean;
}

export interface MailProvider {
  open(): Promise<void>;
  close(): Promise<void>;
  listMailboxes(): Promise<MailboxInfo[]>;
  scanMailbox(
    account: string,
    mailboxPath: string,
    sinceISO: string | undefined,
    onChunk: (messages: MailMessage[], totalSoFar: number) => void
  ): Promise<number>;
  fetchRawBySender(
    mailboxPath: string,
    sender: string,
    since: Date,
    limit: number
  ): Promise<RawMessage[]>;
}

export type MailProviderKind = "imap" | "gmail" | "outlook";

export interface MailConfig {
  provider?: MailProviderKind;
  imap?: { host?: string; port?: number; user?: string; password?: string };
  gmail?: { clientId?: string; clientSecret?: string; refreshToken?: string };
  outlook?: { clientId?: string; clientSecret?: string; tenantId?: string; refreshToken?: string };
}

export function readMailConfig(): MailConfig {
  try {
    const raw = readFileSync(join(process.cwd(), "data", "config.json"), "utf-8");
    const parsed = JSON.parse(raw) as { mail?: MailConfig };
    return parsed.mail ?? {};
  } catch {
    return {};
  }
}

export async function createMailProvider(): Promise<MailProvider> {
  const cfg = readMailConfig();
  const kind = cfg.provider ?? "imap";
  switch (kind) {
    case "imap": {
      const { ImapProvider } = await import("../agent/providers/imap");
      return new ImapProvider(cfg.imap);
    }
    case "gmail": {
      const { GmailProvider } = await import("../agent/providers/gmail");
      return new GmailProvider(cfg.gmail);
    }
    case "outlook": {
      const { OutlookProvider } = await import("../agent/providers/outlook");
      return new OutlookProvider(cfg.outlook);
    }
    default:
      throw new Error(`Unknown mail provider: ${kind}`);
  }
}
