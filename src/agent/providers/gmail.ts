import { google, gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import type {
  MailProvider,
  MailboxInfo,
  MailMessage,
  MoveResult,
  RawMessage,
} from "../../lib/mail-provider";

interface GmailConfig {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
}

function getCreds(cfg?: GmailConfig) {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? cfg?.clientId;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? cfg?.clientSecret;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN ?? cfg?.refreshToken;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing Gmail credentials. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN in .env.local (or data/config.json mail.gmail)."
    );
  }
  return { clientId, clientSecret, refreshToken };
}

function decodeHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function parseFrom(raw: string): { email: string; name: string } {
  // "Name <email>" or "email"
  const m = raw.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  if (m) return { name: m[1]?.trim() ?? "", email: m[2].trim().toLowerCase() };
  return { name: "", email: raw.trim().toLowerCase() };
}

function gmailDateQuery(d: Date): string {
  // Gmail q syntax: after:YYYY/MM/DD
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

export class GmailProvider implements MailProvider {
  private cfg?: GmailConfig;
  private client: gmail_v1.Gmail | null = null;
  private auth: OAuth2Client | null = null;
  private account = "";

  constructor(cfg?: GmailConfig) {
    this.cfg = cfg;
  }

  async open(): Promise<void> {
    const { clientId, clientSecret, refreshToken } = getCreds(this.cfg);
    this.auth = new google.auth.OAuth2(clientId, clientSecret);
    this.auth.setCredentials({ refresh_token: refreshToken });
    this.client = google.gmail({ version: "v1", auth: this.auth });
    const profile = await this.client.users.getProfile({ userId: "me" });
    this.account = profile.data.emailAddress ?? "me";
  }

  async close(): Promise<void> {
    this.client = null;
    this.auth = null;
  }

  private gmail(): gmail_v1.Gmail {
    if (!this.client) throw new Error("Gmail provider not opened");
    return this.client;
  }

  async listMailboxes(): Promise<MailboxInfo[]> {
    const gmail = this.gmail();
    const list = await gmail.users.labels.list({ userId: "me" });
    const labels = list.data.labels ?? [];
    const out: MailboxInfo[] = [];
    for (const lbl of labels) {
      if (!lbl.id) continue;
      const detail = await gmail.users.labels.get({ userId: "me", id: lbl.id });
      out.push({
        name: lbl.name ?? lbl.id,
        account: this.account,
        messageCount: detail.data.messagesTotal ?? 0,
        unreadCount: detail.data.messagesUnread ?? 0,
      });
    }
    return out;
  }

  private async labelIdByName(name: string): Promise<string> {
    const gmail = this.gmail();
    const list = await gmail.users.labels.list({ userId: "me" });
    const found = list.data.labels?.find((l) => l.name === name || l.id === name);
    if (!found?.id) throw new Error(`Gmail label not found: ${name}`);
    return found.id;
  }

  async scanMailbox(
    account: string,
    mailboxPath: string,
    sinceISO: string | undefined,
    onChunk: (messages: MailMessage[], totalSoFar: number) => void
  ): Promise<number> {
    const gmail = this.gmail();
    const labelId = await this.labelIdByName(mailboxPath);
    const q = sinceISO ? `after:${gmailDateQuery(new Date(sinceISO))}` : undefined;

    const CHUNK_SIZE = 500;
    let total = 0;
    let pageToken: string | undefined;
    let buffer: MailMessage[] = [];

    const flush = () => {
      if (buffer.length === 0) return;
      total += buffer.length;
      onChunk(buffer, total);
      buffer = [];
    };

    do {
      const page = await gmail.users.messages.list({
        userId: "me",
        labelIds: [labelId],
        q,
        maxResults: 500,
        pageToken,
      });
      const ids = (page.data.messages ?? []).map((m) => m.id!).filter(Boolean);
      pageToken = page.data.nextPageToken ?? undefined;
      if (ids.length === 0) continue;

      // Fetch metadata in parallel batches of 20 to balance throughput with rate limits.
      for (let i = 0; i < ids.length; i += 20) {
        const slice = ids.slice(i, i + 20);
        const metas = await Promise.all(
          slice.map((id) =>
            gmail.users.messages.get({
              userId: "me",
              id,
              format: "metadata",
              metadataHeaders: ["From", "Subject", "Date", "Message-ID"],
            })
          )
        );
        for (const r of metas) {
          const msg = r.data;
          const headers = msg.payload?.headers;
          const from = parseFrom(decodeHeader(headers, "From"));
          const subject = decodeHeader(headers, "Subject");
          const dateHeader = decodeHeader(headers, "Date");
          const messageId = decodeHeader(headers, "Message-ID").trim();
          const ts = msg.internalDate ? Number(msg.internalDate) : (dateHeader ? Date.parse(dateHeader) : Date.now());
          const labelIds = msg.labelIds ?? [];
          const isRead = !labelIds.includes("UNREAD");
          buffer.push({
            id: messageId.length > 0 ? messageId : `gmail:${msg.id}`,
            mailbox: mailboxPath,
            account,
            senderEmail: from.email,
            senderName: from.name,
            subject,
            dateReceived: new Date(ts).toISOString(),
            isRead,
            sizeBytes: msg.sizeEstimate ?? 0,
          });
          if (buffer.length >= CHUNK_SIZE) flush();
        }
      }
    } while (pageToken);

    flush();
    return total;
  }

  async createMailbox(path: string): Promise<void> {
    const gmail = this.gmail();
    // Gmail label names can contain "/" natively — labels are flat, "/" is just
    // a UI nesting hint. Idempotent: skip if a label with this name already exists.
    const existing = await gmail.users.labels.list({ userId: "me" });
    if (existing.data.labels?.some((l) => l.name === path)) return;
    await gmail.users.labels.create({
      userId: "me",
      requestBody: {
        name: path,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
    });
  }

  async moveMessages(
    messageIds: string[],
    fromMailbox: string,
    toMailbox: string
  ): Promise<MoveResult[]> {
    if (messageIds.length === 0) return [];
    const gmail = this.gmail();
    const [fromId, toId] = await Promise.all([
      this.labelIdByName(fromMailbox),
      this.labelIdByName(toMailbox),
    ]);
    const results: MoveResult[] = [];
    for (const id of messageIds) {
      try {
        // Look up Gmail message id from RFC822 Message-ID.
        const stripped = id.replace(/^<|>$/g, "");
        const search = await gmail.users.messages.list({
          userId: "me",
          q: `rfc822msgid:${stripped}`,
          maxResults: 1,
        });
        const gmailMsgId = search.data.messages?.[0]?.id;
        if (!gmailMsgId) {
          results.push({ messageId: id, ok: false, error: "not found via rfc822msgid" });
          continue;
        }
        await gmail.users.messages.modify({
          userId: "me",
          id: gmailMsgId,
          requestBody: { addLabelIds: [toId], removeLabelIds: [fromId] },
        });
        results.push({ messageId: id, ok: true });
      } catch (err) {
        results.push({
          messageId: id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
    const gmail = this.gmail();
    const labelId = await this.labelIdByName(mailboxPath).catch(() => "");
    const q = `from:${sender} after:${gmailDateQuery(since)}`;
    const page = await gmail.users.messages.list({
      userId: "me",
      q,
      maxResults: limit,
      labelIds: labelId ? [labelId] : undefined,
    });
    const ids = (page.data.messages ?? []).map((m) => m.id!).filter(Boolean).slice(0, limit);
    const out: RawMessage[] = [];
    let uid = 1;
    for (const id of ids) {
      const r = await gmail.users.messages.get({ userId: "me", id, format: "raw" });
      const raw = r.data.raw;
      if (!raw) continue;
      const source = Buffer.from(raw, "base64url");
      out.push({
        uid: uid++,
        source,
        isRead: !(r.data.labelIds ?? []).includes("UNREAD"),
      });
    }
    return out;
  }
}
