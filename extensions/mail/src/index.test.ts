import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnimaExtension, ExtensionContext, LoggerLike } from "@anima/shared";
import { createMailExtension } from "./index";

const INBOX = "200366000000008014";

const silentLog: LoggerLike = {
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLog;
  },
};

function testDb(): Database {
  const sql = readFileSync(
    join(import.meta.dir, "..", "..", "..", "packages", "gateway", "migrations", "026-mail.sql"),
    "utf8",
  );
  const db = new Database(":memory:");
  db.exec(sql.split("-- Down")[0].replace("-- Up", ""));
  return db;
}

describe("mail extension", () => {
  let ext: AnimaExtension;
  let requested: string[];

  beforeEach(async () => {
    requested = [];
    const fetchImpl = async (input: string) => {
      requested.push(input);
      if (input.includes("/oauth/v2/token")) {
        return Response.json({ access_token: "a", expires_in: 3600 });
      }
      const ok = (data: unknown) =>
        Response.json({ status: { code: 200, description: "success" }, data });
      if (input.endsWith("/folders")) {
        return ok([{ folderId: INBOX, folderName: "Inbox", folderType: "Inbox" }]);
      }
      return ok([]);
    };
    ext = createMailExtension(
      {
        address: "claudia@iamclaudia.ai",
        clientId: "c",
        clientSecret: "s",
        refreshToken: "r",
        accountId: "902705288",
        reconcileMinutes: 60,
      },
      { db: testDb(), fetch: fetchImpl },
    );
    const data: Record<string, unknown> = {};
    const ctx: ExtensionContext = {
      on: () => () => {},
      emit: () => {},
      call: async () => ({}),
      connectionId: null,
      tags: null,
      config: {},
      log: silentLog,
      createLogger: () => silentLog,
      store: {
        get: <T>(key: string) => data[key] as T | undefined,
        set: (key, value) => {
          data[key] = value;
        },
        delete: (key) => delete data[key],
        all: () => data,
      },
    };
    await ext.start(ctx);
  });

  afterEach(async () => {
    await ext.stop();
  });

  it("applies schema defaults: list_messages with no params lists the Inbox", async () => {
    const result = (await ext.handleMethod("mail.list_messages", {})) as { folder: string };
    expect(result.folder).toBe("Inbox");
    const listing = requested.find((url) => url.includes("/messages/view"));
    expect(listing).toContain(`folderId=${INBOX}`);
    expect(listing).toContain("limit=25");
  });

  it("exposes the read and manage tools over MCP, and reply as the only send", async () => {
    expect(ext.mcpTools?.map((t) => t.name)).toEqual([
      "mail_list_folders",
      "mail_list_messages",
      "mail_search",
      "mail_read",
      "mail_mark_read",
      "mail_archive",
      "mail_move",
      "mail_reply",
    ]);
    const listed = await ext.handleMcpTool!("mail_list_messages", {});
    expect(JSON.parse(String(listed.content[0].text)).folder).toBe("Inbox");

    const bad = await ext.handleMcpTool!("mail_mark_read", { messageIds: ["1; drop"] });
    expect(bad.isError).toBe(true);
    await expect(ext.handleMcpTool!("mail_send", {})).rejects.toThrow("Unknown MCP tool");
  });

  it("rejects ids that aren't digits before reaching Zoho", async () => {
    await expect(ext.handleMethod("mail.mark_read", { messageIds: ["1,2"] })).rejects.toThrow();
    await expect(ext.handleMethod("mail.mark_read", { messageIds: [] })).rejects.toThrow();
    expect(requested.some((url) => url.includes("updatemessage"))).toBe(false);
  });
});

describe("mail.reply", () => {
  const DAN = "dan@client.example";
  // id → [from, DMARC-verified?]
  const MESSAGES: Record<string, [string, boolean]> = {
    "111": [DAN, true],
    "222": ["stranger@else.example", true],
    "333": [DAN, false],
    "444": ["kiliman@gmail.com", true],
  };
  let ext: AnimaExtension;
  let posts: Array<{ url: string; body: Record<string, unknown> }>;
  let calls: Array<{ method: string; params: Record<string, unknown> }>;

  beforeEach(async () => {
    posts = [];
    calls = [];
    const ok = (data: unknown) =>
      Response.json({ status: { code: 200, description: "success" }, data });
    const fetchImpl = async (input: string, init?: RequestInit) => {
      if (input.includes("/oauth/v2/token")) {
        return Response.json({ access_token: "a", expires_in: 3600 });
      }
      if (input.endsWith("/folders")) {
        return ok([{ folderId: INBOX, folderName: "Inbox", folderType: "Inbox" }]);
      }
      if (init?.method === "POST") {
        posts.push({ url: input, body: JSON.parse(String(init.body)) });
        return ok({ messageId: "999" });
      }
      const m = input.match(/\/messages\/(\d+)\/(details|header)/);
      if (m && MESSAGES[m[1]]) {
        const [from, verified] = MESSAGES[m[1]];
        if (m[2] === "details") {
          return ok({
            messageId: m[1],
            folderId: INBOX,
            subject: "Missouri inventory",
            fromAddress: from,
            sender: "Sender",
          });
        }
        const domain = from.split("@")[1];
        const results = `mx.zohomail.com; dkim=pass; spf=pass; dmarc=${verified ? "pass" : "fail"} header.from=${domain}`;
        return ok({ headerContent: { "Authentication-Results": [results] } });
      }
      return ok([]);
    };
    ext = createMailExtension(
      {
        address: "claudia@iamclaudia.ai",
        clientId: "c",
        clientSecret: "s",
        refreshToken: "r",
        accountId: "902705288",
        reconcileMinutes: 60,
        principals: ["kiliman@gmail.com"],
        contacts: [DAN],
        replyLimits: { perRecipientPerHour: 2, perDay: 20 },
      },
      { db: testDb(), fetch: fetchImpl },
    );
    const data: Record<string, unknown> = {};
    await ext.start({
      on: () => () => {},
      emit: () => {},
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return {};
      },
      connectionId: null,
      tags: null,
      config: {},
      log: silentLog,
      createLogger: () => silentLog,
      store: {
        get: <T>(key: string) => data[key] as T | undefined,
        set: (key, value) => {
          data[key] = value;
        },
        delete: (key) => delete data[key],
        all: () => data,
      },
    } as ExtensionContext);
  });

  afterEach(async () => {
    await ext.stop();
  });

  const reply = (messageId: string) =>
    ext.handleMethod("mail.reply", { messageId, folderId: INBOX, body: "Thanks, Dan!" });

  it("replies in the thread to a verified contact, to the sender only, and notifies Michael", async () => {
    const result = (await reply("111")) as Record<string, unknown>;
    expect(result).toMatchObject({ sent: true, to: DAN, role: "contact" });
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toEndWith("/messages/111");
    expect(posts[0].body).toEqual({
      fromAddress: "claudia@iamclaudia.ai",
      toAddress: DAN,
      subject: "Re: Missouri inventory",
      content: "Thanks, Dan!",
      mailFormat: "plaintext",
      action: "reply",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("notify.send");
    expect(String(calls[0].params.message)).toContain(DAN);
  });

  it("refuses unknown senders and contacts whose mail failed DMARC", async () => {
    await expect(reply("222")).rejects.toThrow("Can't reply");
    await expect(reply("333")).rejects.toThrow("Can't reply");
    expect(posts).toHaveLength(0);
  });

  it("can't be pointed at another recipient", async () => {
    await ext.handleMethod("mail.reply", {
      messageId: "111",
      folderId: INBOX,
      body: "hi",
      to: "evil@attacker.example",
    });
    expect(posts[0].body.toAddress).toBe(DAN);
  });

  it("rate-limits replies to one recipient", async () => {
    await reply("111");
    await reply("111");
    await expect(reply("111")).rejects.toThrow("Reply limit reached");
    expect(posts).toHaveLength(2);
  });

  it("reports roles: only an authenticated principal is trusted", async () => {
    const dan = (await ext.handleMethod("mail.verify_sender", {
      messageId: "111",
      folderId: INBOX,
    })) as Record<string, unknown>;
    expect(dan).toMatchObject({ role: "contact", trusted: false });
    const michael = (await ext.handleMethod("mail.verify_sender", {
      messageId: "444",
      folderId: INBOX,
    })) as Record<string, unknown>;
    expect(michael).toMatchObject({ role: "principal", trusted: true });
  });
});
