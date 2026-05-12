import { ImapFlow } from "imapflow";

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
}

function getCreds() {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASSWORD;
  if (!host || !user || !pass) {
    throw new Error(
      "Missing IMAP credentials. Set IMAP_HOST, IMAP_USER, IMAP_PASSWORD in .env.local"
    );
  }
  return {
    host,
    user,
    pass,
    port: parseInt(process.env.IMAP_PORT || "993", 10),
  };
}

async function newClient(): Promise<ImapFlow> {
  const { host, port, user, pass } = getCreds();
  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass },
    logger: false,
    socketTimeout: 5 * 60 * 1000, // 5 min — long fetches can be slow
  });
  await client.connect();
  return client;
}

export class MailSession {
  private client: ImapFlow | null = null;

  async open(): Promise<void> {
    this.client = await newClient();
  }

  async close(): Promise<void> {
    if (!this.client) return;
    try { await this.client.logout(); } catch {}
    this.client = null;
  }

  private async getClient(): Promise<ImapFlow> {
    if (!this.client || !this.client.usable) {
      console.log("  (reconnecting IMAP...)");
      this.client = await newClient();
    }
    return this.client;
  }

  async listMailboxes(): Promise<MailboxInfo[]> {
    const { user } = getCreds();
    const client = await this.getClient();
    const result: MailboxInfo[] = [];
    const boxes = await client.list();
    for (const box of boxes) {
      if (box.flags?.has("\\Noselect")) continue;
      try {
        const status = await client.status(box.path, { messages: true, unseen: true });
        result.push({
          name: box.path,
          account: user,
          messageCount: status.messages ?? 0,
          unreadCount: status.unseen ?? 0,
        });
      } catch {
        // Skip mailboxes that can't be statused
      }
    }
    return result;
  }

  // Scans a mailbox. Retries once on transient connection failure.
  async scanMailbox(
    account: string,
    mailboxPath: string,
    sinceISO: string | undefined,
    onChunk: (messages: MailMessage[], totalSoFar: number) => void
  ): Promise<number> {
    try {
      return await this.scanMailboxOnce(account, mailboxPath, sinceISO, onChunk);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/ETIMEDOUT|ECONNRESET|EPIPE|usable/i.test(msg)) throw err;
      console.log(`  (transient error: ${msg} — reconnecting and retrying)`);
      this.client = null;
      return this.scanMailboxOnce(account, mailboxPath, sinceISO, onChunk);
    }
  }

  private async scanMailboxOnce(
    account: string,
    mailboxPath: string,
    sinceISO: string | undefined,
    onChunk: (messages: MailMessage[], totalSoFar: number) => void
  ): Promise<number> {
    const CHUNK_SIZE = 500;
    const client = await this.getClient();
    const lock = await client.getMailboxLock(mailboxPath);
    try {
      const search = sinceISO ? { since: new Date(sinceISO) } : { all: true };

      let total = 0;
      let buffer: MailMessage[] = [];

      const flush = () => {
        if (buffer.length === 0) return;
        total += buffer.length;
        onChunk(buffer, total);
        buffer = [];
      };

      for await (const msg of client.fetch(search, {
        uid: true,
        envelope: true,
        flags: true,
        size: true,
      })) {
        const from = msg.envelope?.from?.[0];
        const date = msg.envelope?.date ?? new Date();
        const messageId = msg.envelope?.messageId?.trim();
        const id = messageId && messageId.length > 0
          ? messageId
          : `${mailboxPath}:${msg.uid}`;

        buffer.push({
          id,
          mailbox: mailboxPath,
          account,
          senderEmail: (from?.address ?? "").toLowerCase(),
          senderName: from?.name ?? "",
          subject: msg.envelope?.subject ?? "",
          dateReceived: date.toISOString(),
          isRead: msg.flags?.has("\\Seen") ?? false,
          sizeBytes: msg.size ?? 0,
        });

        if (buffer.length >= CHUNK_SIZE) flush();
      }
      flush();

      return total;
    } finally {
      lock.release();
    }
  }
}
