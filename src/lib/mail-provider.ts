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

export interface MoveResult {
  messageId: string;
  ok: boolean;
  error?: string;
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
  /**
   * Create a mailbox/folder/label at the given path. Hierarchical paths use "/"
   * (e.g. "Newsletters/Tech"). Idempotent — succeeds if the destination already exists.
   */
  createMailbox(path: string): Promise<void>;
  /**
   * Move messages identified by their stable Message-ID (the `id` stored in SQLite)
   * from one mailbox to another. Returns per-message status — partial failures do
   * not throw. For Gmail, "move" means add the destination label and remove the
   * source label.
   */
  moveMessages(
    messageIds: string[],
    fromMailbox: string,
    toMailbox: string
  ): Promise<MoveResult[]>;
}

export type MailProviderKind = "imap" | "gmail" | "outlook";

export interface MailConfig {
  provider?: MailProviderKind;
  imap?: { host?: string; port?: number; user?: string; password?: string };
  gmail?: { clientId?: string; clientSecret?: string; refreshToken?: string };
  outlook?: { clientId?: string; clientSecret?: string; tenantId?: string; refreshToken?: string };
}

export async function createMailProvider(userId: string): Promise<MailProvider> {
  const { getMailCredentials } = await import("./credentials");
  const cfg = await getMailCredentials(userId);
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
