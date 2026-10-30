import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMailConfig } from "./config";
import { checkAttachments, sendMail, sendSchema } from "./send";
import { ZohoMailClient } from "./zoho";

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
  contentType: string | undefined;
  body: string;
}

function fakeZoho() {
  const calls: Call[] = [];
  let uploads = 0;
  const impl = async (input: string, init?: RequestInit) => {
    if (input.includes("/oauth/v2/token")) {
      return Response.json({ access_token: "access", expires_in: 3600 });
    }
    const raw = init?.body;
    const body = raw instanceof Blob ? await raw.text() : String(raw ?? "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: input,
      method: init?.method ?? "GET",
      contentType: headers["Content-Type"],
      body,
    });
    const ok = (data: unknown) => Response.json({ status: { code: 200 }, data });
    if (input.includes("/messages/attachments")) {
      uploads++;
      const name = new URL(input).searchParams.get("fileName");
      return ok({
        storeName: `NN2:${uploads}`,
        attachmentPath: `/Mail/${name}`,
        attachmentName: name,
      });
    }
    // A long Zoho id must come back exact, not rounded.
    return ok({ messageId: "1792870955365152800" });
  };
  return { impl, calls };
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "anima-mail-send-"));
  writeFileSync(join(dir, "report.pdf"), "%PDF-1.4 fake");
  writeFileSync(join(dir, "notes.txt"), "hello");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("sendSchema", () => {
  it("accepts a single address and path, defaults to plaintext, flattens the subject", () => {
    const p = sendSchema.parse({
      to: "jane@acme.com",
      subject: "Q3\r\nBcc: evil@x.com",
      body: "Hi",
      attachments: "/tmp/a.pdf",
    });
    expect(p.to).toEqual(["jane@acme.com"]);
    expect(p.attachments).toEqual(["/tmp/a.pdf"]);
    expect(p.format).toBe("plaintext");
    expect(p.subject).toBe("Q3 Bcc: evil@x.com");
  });

  it("rejects bad addresses and non-numeric replyTo", () => {
    expect(() => sendSchema.parse({ to: "nope", subject: "s", body: "b" })).toThrow();
    expect(() =>
      sendSchema.parse({ to: "a@b.co", subject: "s", body: "b", replyTo: "1/../x" }),
    ).toThrow();
  });
});

describe("checkAttachments", () => {
  it("refuses relative paths, directories and missing files", async () => {
    await expect(checkAttachments(["report.pdf"])).rejects.toThrow("must be absolute");
    await expect(checkAttachments([dir])).rejects.toThrow("not a file");
    await expect(checkAttachments([join(dir, "missing.pdf")])).rejects.toThrow("not a file");
  });
});

describe("sendMail", () => {
  it("uploads each attachment raw, then sends with them attached", async () => {
    const { impl, calls } = fakeZoho();
    const client = new ZohoMailClient(config, impl);
    const result = await sendMail(
      client,
      sendSchema.parse({
        to: ["jane@acme.com", "bob@acme.com"],
        cc: "michael@kiliman.dev",
        subject: "Q3 report",
        body: "Attached.",
        attachments: [join(dir, "report.pdf"), join(dir, "notes.txt")],
      }),
    );

    const [up1, up2, send] = calls;
    expect(up1.url).toContain("/messages/attachments?fileName=report.pdf");
    expect(up1.contentType).toBe("application/octet-stream");
    expect(up1.body).toBe("%PDF-1.4 fake");
    expect(up2.url).toContain("fileName=notes.txt");
    expect(send.url).toBe("https://mail.zoho.com/api/accounts/902705288/messages");
    expect(JSON.parse(send.body)).toEqual({
      fromAddress: '"Claudia" <claudia@iamclaudia.ai>',
      toAddress: "jane@acme.com,bob@acme.com",
      ccAddress: "michael@kiliman.dev",
      subject: "Q3 report",
      content: "Attached.",
      mailFormat: "plaintext",
      attachments: [
        { storeName: "NN2:1", attachmentPath: "/Mail/report.pdf", attachmentName: "report.pdf" },
        { storeName: "NN2:2", attachmentPath: "/Mail/notes.txt", attachmentName: "notes.txt" },
      ],
    });
    expect(result.messageId).toBe("1792870955365152800");
    expect(result.attachments).toEqual([
      { name: "report.pdf", bytes: 13 },
      { name: "notes.txt", bytes: 5 },
    ]);
  });

  it("replies in the original thread", async () => {
    const { impl, calls } = fakeZoho();
    const client = new ZohoMailClient(config, impl);
    await sendMail(
      client,
      sendSchema.parse({
        to: "jane@acme.com",
        subject: "Re: Q3",
        body: "Done!",
        replyTo: "1792870692631152800",
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toEndWith("/messages/1792870692631152800");
    expect(JSON.parse(calls[0].body)).toMatchObject({
      action: "reply",
      toAddress: "jane@acme.com",
    });
  });

  it("sends nothing when any attachment is bad", async () => {
    const { impl, calls } = fakeZoho();
    const client = new ZohoMailClient(config, impl);
    await expect(
      sendMail(
        client,
        sendSchema.parse({
          to: "jane@acme.com",
          subject: "s",
          body: "b",
          attachments: [join(dir, "report.pdf"), join(dir, "missing.pdf")],
        }),
      ),
    ).rejects.toThrow("not a file");
    expect(calls).toHaveLength(0);
  });
});
