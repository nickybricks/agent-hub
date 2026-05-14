import type {
  MailProvider,
  MailboxInfo,
  MailMessage,
  MoveResult,
  RawMessage,
} from "../../lib/mail-provider";

interface OutlookConfig {
  clientId?: string;
  clientSecret?: string;
  tenantId?: string;
  refreshToken?: string;
}

function getCreds(cfg?: OutlookConfig) {
  const clientId = process.env.MS_CLIENT_ID ?? cfg?.clientId;
  const clientSecret = process.env.MS_CLIENT_SECRET ?? cfg?.clientSecret;
  const tenantId = process.env.MS_TENANT_ID ?? cfg?.tenantId ?? "common";
  const refreshToken = process.env.MS_REFRESH_TOKEN ?? cfg?.refreshToken;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing Outlook credentials. Set MS_CLIENT_ID, MS_CLIENT_SECRET, MS_REFRESH_TOKEN (and optional MS_TENANT_ID) in .env.local."
    );
  }
  return { clientId, clientSecret, tenantId, refreshToken };
}

interface MailFolder {
  id: string;
  displayName: string;
  parentFolderId?: string;
  totalItemCount?: number;
  unreadItemCount?: number;
  childFolderCount?: number;
}

interface GraphMessage {
  id: string;
  subject?: string;
  receivedDateTime?: string;
  isRead?: boolean;
  internetMessageId?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  bodyPreview?: string;
}

export class OutlookProvider implements MailProvider {
  private cfg?: OutlookConfig;
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private account = "";

  constructor(cfg?: OutlookConfig) {
    this.cfg = cfg;
  }

  async open(): Promise<void> {
    await this.refreshAccessToken();
    const me = await this.graph<{ mail?: string; userPrincipalName?: string }>("/me?$select=mail,userPrincipalName");
    this.account = me.mail ?? me.userPrincipalName ?? "me";
  }

  async close(): Promise<void> {
    this.accessToken = null;
  }

  private async refreshAccessToken(): Promise<void> {
    const { clientId, clientSecret, tenantId, refreshToken } = getCreds(this.cfg);
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "https://graph.microsoft.com/Mail.ReadWrite offline_access",
    });
    const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    if (!res.ok) {
      throw new Error(`Microsoft OAuth refresh failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.accessTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  }

  private async ensureToken(): Promise<string> {
    if (!this.accessToken || Date.now() > this.accessTokenExpiresAt) {
      await this.refreshAccessToken();
    }
    return this.accessToken!;
  }

  private async graph<T>(path: string): Promise<T> {
    const token = await this.ensureToken();
    const url = path.startsWith("http") ? path : `https://graph.microsoft.com/v1.0${path}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`Graph ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  private async graphJson<T>(
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<T> {
    const token = await this.ensureToken();
    const url = `https://graph.microsoft.com/v1.0${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Graph ${method} ${path} failed: ${res.status} ${await res.text()}`);
    }
    // 204 No Content is valid for some endpoints.
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async graphRaw(path: string): Promise<Buffer> {
    const token = await this.ensureToken();
    const url = `https://graph.microsoft.com/v1.0${path}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`Graph raw ${path} failed: ${res.status} ${await res.text()}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  private async listAllFolders(): Promise<MailFolder[]> {
    const out: MailFolder[] = [];
    const walk = async (parentPath: string): Promise<void> => {
      let url: string | null = `${parentPath}?$top=100`;
      while (url) {
        const page: { value: MailFolder[]; "@odata.nextLink"?: string } =
          await this.graph(url);
        for (const f of page.value) {
          out.push(f);
          if ((f.childFolderCount ?? 0) > 0) {
            await walk(`/me/mailFolders/${f.id}/childFolders`);
          }
        }
        url = page["@odata.nextLink"] ?? null;
      }
    };
    await walk("/me/mailFolders");
    return out;
  }

  private async folderPath(folder: MailFolder, all: MailFolder[]): Promise<string> {
    const byId = new Map(all.map((f) => [f.id, f]));
    const parts: string[] = [folder.displayName];
    let cur: MailFolder | undefined = folder;
    while (cur?.parentFolderId) {
      const parent = byId.get(cur.parentFolderId);
      if (!parent) break;
      parts.unshift(parent.displayName);
      cur = parent;
    }
    return parts.join("/");
  }

  async listMailboxes(): Promise<MailboxInfo[]> {
    const all = await this.listAllFolders();
    const out: MailboxInfo[] = [];
    for (const f of all) {
      out.push({
        name: await this.folderPath(f, all),
        account: this.account,
        messageCount: f.totalItemCount ?? 0,
        unreadCount: f.unreadItemCount ?? 0,
      });
    }
    return out;
  }

  private async folderIdByPath(path: string): Promise<string> {
    const all = await this.listAllFolders();
    for (const f of all) {
      if ((await this.folderPath(f, all)) === path) return f.id;
    }
    throw new Error(`Outlook folder not found: ${path}`);
  }

  async scanMailbox(
    account: string,
    mailboxPath: string,
    sinceISO: string | undefined,
    onChunk: (messages: MailMessage[], totalSoFar: number) => void
  ): Promise<number> {
    const folderId = await this.folderIdByPath(mailboxPath);
    const select = "id,subject,receivedDateTime,isRead,internetMessageId,from,bodyPreview";
    const filter = sinceISO ? `&$filter=receivedDateTime ge ${new Date(sinceISO).toISOString()}` : "";
    let url: string | null = `/me/mailFolders/${folderId}/messages?$select=${select}&$top=100${filter}`;

    const CHUNK_SIZE = 500;
    let total = 0;
    let buffer: MailMessage[] = [];

    const flush = () => {
      if (buffer.length === 0) return;
      total += buffer.length;
      onChunk(buffer, total);
      buffer = [];
    };

    while (url) {
      const page: { value: GraphMessage[]; "@odata.nextLink"?: string } =
        await this.graph(url);
      for (const m of page.value) {
        const addr = m.from?.emailAddress;
        const messageId = (m.internetMessageId ?? "").trim();
        buffer.push({
          id: messageId.length > 0 ? messageId : `outlook:${m.id}`,
          mailbox: mailboxPath,
          account,
          senderEmail: (addr?.address ?? "").toLowerCase(),
          senderName: addr?.name ?? "",
          subject: m.subject ?? "",
          dateReceived: m.receivedDateTime ?? new Date().toISOString(),
          isRead: m.isRead ?? false,
          sizeBytes: (m.bodyPreview?.length ?? 0),
        });
        if (buffer.length >= CHUNK_SIZE) flush();
      }
      url = page["@odata.nextLink"] ?? null;
    }
    flush();
    return total;
  }

  async createMailbox(path: string): Promise<void> {
    const segments = path.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) return;
    const all = await this.listAllFolders();
    const pathOf = async (f: MailFolder) => this.folderPath(f, all);

    // Walk segments, creating each missing level. Track the parent's id as we go.
    let parentId: string | null = null;
    for (let i = 0; i < segments.length; i++) {
      const prefix = segments.slice(0, i + 1).join("/");
      let match: MailFolder | undefined;
      for (const f of all) {
        if ((await pathOf(f)) === prefix) {
          match = f;
          break;
        }
      }
      if (match) {
        parentId = match.id;
        continue;
      }
      // Create under parent (or top-level if parentId is null).
      const created: MailFolder = await this.graphJson<MailFolder>(
        "POST",
        parentId ? `/me/mailFolders/${parentId}/childFolders` : `/me/mailFolders`,
        { displayName: segments[i] }
      );
      // Splice into our local list so subsequent path lookups see it.
      all.push({
        id: created.id,
        displayName: created.displayName,
        parentFolderId: parentId ?? undefined,
      });
      parentId = created.id;
    }
  }

  async moveMessages(
    messageIds: string[],
    _fromMailbox: string,
    toMailbox: string
  ): Promise<MoveResult[]> {
    if (messageIds.length === 0) return [];
    const destId = await this.folderIdByPath(toMailbox);
    const results: MoveResult[] = [];
    for (const id of messageIds) {
      try {
        const escaped = id.replace(/'/g, "''");
        const search = await this.graph<{ value: GraphMessage[] }>(
          `/me/messages?$select=id&$top=1&$filter=${encodeURIComponent(
            `internetMessageId eq '${escaped}'`
          )}`
        );
        const graphId = search.value[0]?.id;
        if (!graphId) {
          results.push({ messageId: id, ok: false, error: "not found via internetMessageId" });
          continue;
        }
        await this.graphJson("POST", `/me/messages/${graphId}/move`, {
          destinationId: destId,
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
    const folderId = await this.folderIdByPath(mailboxPath).catch(() => "");
    const sinceISO = since.toISOString();
    const escaped = sender.replace(/'/g, "''");
    const filter = `from/emailAddress/address eq '${escaped}' and receivedDateTime ge ${sinceISO}`;
    const base = folderId
      ? `/me/mailFolders/${folderId}/messages`
      : `/me/messages`;
    const url = `${base}?$select=id,isRead&$top=${limit}&$filter=${encodeURIComponent(filter)}&$orderby=receivedDateTime desc`;
    const page = await this.graph<{ value: GraphMessage[] }>(url);
    const out: RawMessage[] = [];
    let uid = 1;
    for (const m of page.value.slice(0, limit)) {
      const source = await this.graphRaw(`/me/messages/${m.id}/$value`);
      out.push({ uid: uid++, source, isRead: m.isRead ?? false });
    }
    return out;
  }
}
