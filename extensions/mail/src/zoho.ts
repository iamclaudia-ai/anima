/**
 * Zoho Mail REST client (accounts/<accountId> scope).
 *
 * - Access tokens are refreshed from the stored refresh token and cached until
 *   a minute before expiry.
 * - Every response is parsed losslessly: message and folder ids stay strings.
 * - Ids are spliced into URLs and raw JSON bodies only after `assertId`, so a
 *   body can carry them as bare longs (which Zoho requires) without rounding.
 */

import type { MailConfig } from "./config";
import { assertId, parseJsonLossless } from "./parse";

export class ZohoError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ZohoError";
  }
}

export interface ZohoFolder {
  folderId: string;
  folderName: string;
  folderType: string;
  path?: string;
}

/** A message as Zoho's list, search and details endpoints return it (all strings). */
export interface ZohoMessage {
  messageId: string;
  folderId: string;
  threadId?: string;
  subject: string;
  summary?: string;
  sender?: string;
  fromAddress: string;
  toAddress?: string;
  ccAddress?: string;
  receivedTime?: string;
  /** The search endpoint spells it lowercase. */
  receivedtime?: string;
  sentDateInGMT?: string;
  hasAttachment?: string;
  /** "1"/"0" from list and details, "read"/"unread" from search. */
  status?: string;
}

/** A file in Zoho's store, as the upload endpoint returns it. */
export interface ZohoAttachment {
  storeName: string;
  attachmentPath: string;
  attachmentName: string;
}

export interface OutgoingMessage {
  toAddress: string;
  ccAddress?: string;
  bccAddress?: string;
  subject: string;
  content: string;
  mailFormat: "html" | "plaintext";
  attachments?: ZohoAttachment[];
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface ZohoEnvelope<T> {
  status?: { code?: number; description?: string };
  data?: T;
}

const TOKEN_SKEW_MS = 60_000;

export class ZohoMailClient {
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly config: MailConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private get apiBase(): string {
    return `https://mail.zoho.${this.config.dataCenter}/api/accounts/${this.config.accountId}`;
  }

  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - TOKEN_SKEW_MS) {
      return this.accessToken;
    }
    const res = await this.fetchImpl(
      `https://accounts.zoho.${this.config.dataCenter}/oauth/v2/token`,
      {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          refresh_token: this.config.refreshToken,
        }),
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!res.ok || !body.access_token) {
      throw new ZohoError(
        `Zoho token refresh failed: ${body.error ?? `HTTP ${res.status}`}`,
        res.status,
      );
    }
    this.accessToken = body.access_token;
    this.accessTokenExpiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  private async request<T>(
    method: "GET" | "PUT" | "POST",
    path: string,
    options: {
      query?: Record<string, string | number | boolean | undefined>;
      rawJson?: string;
      /** A raw file body (attachment upload). */
      binary?: Blob;
    } = {},
  ): Promise<T> {
    const url = new URL(`${this.apiBase}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      Authorization: `Zoho-oauthtoken ${await this.token()}`,
      Accept: "application/json",
    };
    let body: string | Blob | undefined;
    if (options.rawJson !== undefined) {
      headers["Content-Type"] = "application/json";
      body = options.rawJson;
    } else if (options.binary !== undefined) {
      headers["Content-Type"] = "application/octet-stream";
      body = options.binary;
    }

    const res = await this.fetchImpl(url.toString(), { method, headers, body });
    const text = await res.text();
    let envelope: ZohoEnvelope<T>;
    try {
      envelope = parseJsonLossless<ZohoEnvelope<T>>(text);
    } catch {
      throw new ZohoError(
        `Zoho ${method} ${path}: HTTP ${res.status} (non-JSON response)`,
        res.status,
      );
    }
    const code = envelope.status?.code ?? res.status;
    if (!res.ok || code !== 200) {
      const description = envelope.status?.description ?? "request failed";
      throw new ZohoError(
        `Zoho ${method} ${path}: ${code} ${description}`,
        res.ok ? code : res.status,
      );
    }
    return envelope.data as T;
  }

  async listFolders(): Promise<ZohoFolder[]> {
    return this.request<ZohoFolder[]>("GET", "/folders");
  }

  async listMessages(params: {
    folderId: string;
    status?: "all" | "read" | "unread";
    start?: number;
    limit?: number;
  }): Promise<ZohoMessage[]> {
    return this.request<ZohoMessage[]>("GET", "/messages/view", {
      query: {
        folderId: assertId(params.folderId, "folderId"),
        status: params.status ?? "all",
        start: params.start ?? 1,
        limit: params.limit ?? 25,
        includeto: true,
      },
    }).then((data) => data ?? []);
  }

  async search(params: {
    searchKey: string;
    start?: number;
    limit?: number;
  }): Promise<ZohoMessage[]> {
    return this.request<ZohoMessage[]>("GET", "/messages/search", {
      query: {
        searchKey: params.searchKey,
        // Without receivedTime Zoho only returns mail older than two minutes.
        receivedTime: Date.now() + 60_000,
        start: params.start ?? 1,
        limit: params.limit ?? 25,
        includeto: true,
      },
    }).then((data) => data ?? []);
  }

  async getDetails(folderId: string, messageId: string): Promise<ZohoMessage> {
    return this.request<ZohoMessage>(
      "GET",
      `/folders/${assertId(folderId, "folderId")}/messages/${assertId(messageId, "messageId")}/details`,
    );
  }

  async getContent(folderId: string, messageId: string): Promise<string> {
    const data = await this.request<{ content?: string }>(
      "GET",
      `/folders/${assertId(folderId, "folderId")}/messages/${assertId(messageId, "messageId")}/content`,
    );
    return data?.content ?? "";
  }

  async getHeaders(folderId: string, messageId: string): Promise<Record<string, string[]>> {
    const data = await this.request<{ headerContent?: Record<string, string[]> }>(
      "GET",
      `/folders/${assertId(folderId, "folderId")}/messages/${assertId(messageId, "messageId")}/header`,
      { query: { raw: false } },
    );
    return data?.headerContent ?? {};
  }

  /** PUT /updatemessage. Ids go into the body as bare longs, as Zoho expects. */
  private async updateMessages(mode: string, messageIds: string[], extra = ""): Promise<void> {
    if (messageIds.length === 0) return;
    const ids = messageIds.map((id) => assertId(id, "messageId")).join(",");
    await this.request("PUT", "/updatemessage", {
      rawJson: `{"mode":${JSON.stringify(mode)},"messageId":[${ids}]${extra}}`,
    });
  }

  async markRead(messageIds: string[]): Promise<void> {
    return this.updateMessages("markAsRead", messageIds);
  }

  async markUnread(messageIds: string[]): Promise<void> {
    return this.updateMessages("markAsUnread", messageIds);
  }

  async archive(messageIds: string[]): Promise<void> {
    return this.updateMessages("archiveMails", messageIds);
  }

  async move(messageIds: string[], destFolderId: string): Promise<void> {
    return this.updateMessages(
      "moveMessage",
      messageIds,
      `,"destfolderId":${assertId(destFolderId, "folderId")}`,
    );
  }

  /** Upload one file (raw body) to Zoho's store, ready to attach to a send. */
  async uploadAttachment(fileName: string, file: Blob): Promise<ZohoAttachment> {
    const data = await this.request<ZohoAttachment | ZohoAttachment[]>(
      "POST",
      "/messages/attachments",
      { query: { fileName }, binary: file },
    );
    const uploaded = Array.isArray(data) ? data[0] : data;
    if (!uploaded?.storeName || !uploaded.attachmentPath) {
      throw new ZohoError(`Zoho attachment upload for ${fileName} returned no file`, 200);
    }
    return {
      storeName: uploaded.storeName,
      attachmentPath: uploaded.attachmentPath,
      attachmentName: uploaded.attachmentName ?? fileName,
    };
  }

  /**
   * Send from Claudia's address. With `replyTo`, Zoho sends it as a reply to
   * that message, in its thread.
   */
  async sendMessage(
    message: OutgoingMessage,
    replyTo?: string,
  ): Promise<{ messageId: string | null }> {
    const path = replyTo ? `/messages/${assertId(replyTo, "messageId")}` : "/messages";
    const payload = {
      fromAddress: this.config.address,
      ...message,
      ...(replyTo ? { action: "reply" } : {}),
    };
    const data = await this.request<{ messageId?: string } | undefined>("POST", path, {
      rawJson: JSON.stringify(payload),
    });
    return { messageId: data?.messageId ?? null };
  }
}
