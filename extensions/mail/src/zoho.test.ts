import { describe, expect, it } from "bun:test";
import { parseMailConfig } from "./config";
import { ZohoError, ZohoMailClient } from "./zoho";

const config = parseMailConfig({
  address: "claudia@iamclaudia.ai",
  clientId: "1000.CLIENT",
  clientSecret: "secret",
  refreshToken: "refresh",
  accountId: "902705288",
});

interface Call {
  url: string;
  method: string;
  body: string | null;
}

function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const impl = async (input: string, init?: RequestInit) => {
    const body = init?.body;
    const call: Call = {
      url: input,
      method: init?.method ?? "GET",
      body: body === undefined || body === null ? null : String(body),
    };
    calls.push(call);
    if (call.url.includes("/oauth/v2/token")) {
      return Response.json({ access_token: "access", expires_in: 3600 });
    }
    return respond(call);
  };
  return { impl, calls };
}

const ok = (data: unknown) =>
  Response.json({ status: { code: 200, description: "success" }, data });

describe("ZohoMailClient", () => {
  it("refreshes the token once and reuses it", async () => {
    const { impl, calls } = fakeFetch(() => ok([]));
    const client = new ZohoMailClient(config, impl);
    await client.listFolders();
    await client.listFolders();
    expect(calls.filter((c) => c.url.includes("/oauth/v2/token"))).toHaveLength(1);
    expect(calls[1].url).toBe("https://mail.zoho.com/api/accounts/902705288/folders");
  });

  it("sends message ids as exact bare longs", async () => {
    const { impl, calls } = fakeFetch(() => ok(undefined));
    const client = new ZohoMailClient(config, impl);
    await client.markRead(["1792870955365152800", "1792870692631152800"]);
    await client.move(["1792870955365152800"], "200366000000009021");
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts[0].url).toEndWith("/updatemessage");
    expect(puts[0].body).toBe(
      '{"mode":"markAsRead","messageId":[1792870955365152800,1792870692631152800]}',
    );
    expect(puts[1].body).toBe(
      '{"mode":"moveMessage","messageId":[1792870955365152800],"destfolderId":200366000000009021}',
    );
  });

  it("refuses ids that aren't digits before any request", async () => {
    const { impl, calls } = fakeFetch(() => ok(undefined));
    const client = new ZohoMailClient(config, impl);
    await expect(client.markRead(['1]}, {"mode":"x'])).rejects.toThrow("Invalid messageId");
    await expect(client.getDetails("../x", "1")).rejects.toThrow("Invalid folderId");
    expect(calls).toHaveLength(0);
  });

  it("turns an HTML 404 into a ZohoError with the status", async () => {
    const { impl } = fakeFetch(() => new Response("<html>nope</html>", { status: 404 }));
    const client = new ZohoMailClient(config, impl);
    const error = await client.getDetails("1", "2").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZohoError);
    expect((error as ZohoError).status).toBe(404);
  });

  it("keeps ids lossless in responses", async () => {
    const { impl } = fakeFetch(
      () =>
        new Response(
          '{"status":{"code":200,"description":"success"},"data":[{"messageId":1792870955365152800,"folderId":"1","fromAddress":"a@b.c","subject":"s"}]}',
        ),
    );
    const client = new ZohoMailClient(config, impl);
    const [message] = await client.listMessages({ folderId: "1" });
    expect(message.messageId).toBe("1792870955365152800");
  });
});
