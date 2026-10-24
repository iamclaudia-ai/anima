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

  it("exposes exactly the read and manage tools over MCP (nothing that sends)", async () => {
    expect(ext.mcpTools?.map((t) => t.name)).toEqual([
      "mail_list_folders",
      "mail_list_messages",
      "mail_search",
      "mail_read",
      "mail_mark_read",
      "mail_archive",
      "mail_move",
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
