import { ImapFlow } from "imapflow";
import type {
  MailProvider,
  MailboxInfo,
  MailMessage,
  MoveResult,
  RawMessage,
} from "../../lib/mail-provider";

interface ImapConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
}

function getCreds(cfg?: ImapConfig) {
  const host = process.env.IMAP_HOST ?? cfg?.host;
  const user = process.env.IMAP_USER ?? cfg?.user;
  const pass = process.env.IMAP_PASSWORD ?? cfg?.password;
  const port = parseInt(
    process.env.IMAP_PORT ?? (cfg?.port != null ? String(cfg.port) : "993"),
    10
  );
  if (!host || !user || !pass) {
    throw new Error(
      "Missing IMAP credentials. Set IMAP_HOST, IMAP_USER, IMAP_PASSWORD in .env.local (or data/config.json mail.imap)."
    );
  }
  return { host, user, pass, port };
}

const AUDIT_HEADER_KEYS: Record<string, "auth" | "lu" | "prec" | "as"> = {
  "authentication-results": "auth",
  "list-unsubscribe": "lu",
  precedence: "prec",
  "auto-submitted": "as",
};

function parseAuditHeaders(headers: Buffer | undefined): string | null {
  if (!headers || headers.length === 0) return null;
  const text = headers.toString("utf-8");
  const unfolded = text.replace(/\r?\n[ \t]+/g, " ");
  const out: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const key = AUDIT_HEADER_KEYS[name];
    if (!key) continue;
    const value = line.slice(idx + 1).trim();
    if (!value) continue;
    out[key] = out[key] ? `${out[key]}; ${value}` : value;
  }
  return Object.keys(out).length === 0 ? null : JSON.stringify(out);
}

async function newClient(cfg?: ImapConfig): Promise<ImapFlow> {
  const { host, port, user, pass } = getCreds(cfg);
  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass },
    logger: false,
    socketTimeout: 5 * 60 * 1000,
  });
  await client.connect();
  return client;
}

export class ImapProvider implements MailProvider {
  private client: ImapFlow | null = null;
  private cfg?: ImapConfig;

  constructor(cfg?: ImapConfig) {
    this.cfg = cfg;
  }

  async open(): Promise<void> {
    this.client = await newClient(this.cfg);
  }

  async close(): Promise<void> {
    if (!this.client) return;
    try { await this.client.logout(); } catch {}
    this.client = null;
  }

  private async getClient(): Promise<ImapFlow> {
    if (!this.client || !this.client.usable) {
      console.log("  (reconnecting IMAP...)");
      this.client = await newClient(this.cfg);
    }
    return this.client;
  }

  async listMailboxes(): Promise<MailboxInfo[]> {
    const { user } = getCreds(this.cfg);
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
        headers: ["authentication-results", "list-unsubscribe", "precedence", "auto-submitted"],
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
          headersJson: parseAuditHeaders(msg.headers),
        });

        if (buffer.length >= CHUNK_SIZE) flush();
      }
      flush();

      return total;
    } finally {
      lock.release();
    }
  }

  async createMailbox(path: string): Promise<void> {
    const client = await this.getClient();
    // Walk path segments so parent folders exist first. Ignore "already exists" errors.
    const segments = path.split("/").filter((s) => s.length > 0);
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join("/");
      try {
        await client.mailboxCreate(prefix);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/exists|already/i.test(msg)) throw err;
      }
    }
  }

  async moveMessages(
    messageIds: string[],
    fromMailbox: string,
    toMailbox: string
  ): Promise<MoveResult[]> {
    if (messageIds.length === 0) return [];
    const client = await this.getClient();
    const results: MoveResult[] = [];
    const lock = await client.getMailboxLock(fromMailbox);
    try {
      for (const id of messageIds) {
        try {
          const uids = await client.search({ header: { "message-id": id } }, { uid: true });
          if (!uids || uids.length === 0) {
            results.push({ messageId: id, ok: false, error: "not found in source mailbox" });
            continue;
          }
          await client.messageMove(uids, toMailbox, { uid: true });
          results.push({ messageId: id, ok: true });
        } catch (err) {
          results.push({
            messageId: id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } finally {
      lock.release();
    }
    return results;
  }

  async fetchRawBySender(
    mailboxPath: string,
    sender: string,
    since: Date,
    limit: number
  ): Promise<RawMessage[]> {
    if (limit <= 0) return [];
    const client = await this.getClient();
    const lock = await client.getMailboxLock(mailboxPath);
    try {
      const uids = await client.search({ from: sender, since }, { uid: true });
      if (!uids || uids.length === 0) return [];
      const slice = uids.slice(-limit).reverse();
      const out: RawMessage[] = [];
      for await (const msg of client.fetch(slice, { uid: true, source: true, flags: true }, { uid: true })) {
        if (!msg.source) continue;
        out.push({
          uid: msg.uid,
          source: msg.source,
          isRead: msg.flags?.has("\\Seen") ?? false,
        });
      }
      return out;
    } finally {
      lock.release();
    }
  }
}
