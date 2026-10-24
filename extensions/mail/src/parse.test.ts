import { describe, expect, it } from "bun:test";
import {
  assertId,
  decodeAddressList,
  htmlToText,
  isAuthenticatedSender,
  parseAuthentication,
  parseJsonLossless,
} from "./parse";

describe("parseJsonLossless", () => {
  it("keeps 16+ digit integers exact, as strings", () => {
    const parsed = parseJsonLossless<{ data: { messageId: string; size: number; ids: string[] } }>(
      '{"data":{"messageId":1792870955365152800,"size":1214,"ids":[1792870955365152801, 12]}}',
    );
    expect(parsed.data.messageId).toBe("1792870955365152800");
    expect(parsed.data.size).toBe(1214);
    expect(parsed.data.ids).toEqual(["1792870955365152801", 12] as unknown as string[]);
  });

  it("leaves digit runs inside strings alone, even next to commas", () => {
    const text =
      '{"subject":"order ,1792870955365152800, shipped \\" ,1234567890123456789]","n":1.5e3}';
    const parsed = parseJsonLossless<{ subject: string; n: number }>(text);
    expect(parsed.subject).toBe('order ,1792870955365152800, shipped " ,1234567890123456789]');
    expect(parsed.n).toBe(1500);
  });
});

describe("assertId", () => {
  it("accepts digits and rejects anything else", () => {
    expect(assertId("200366000000008014")).toBe("200366000000008014");
    expect(() => assertId("12/../34")).toThrow();
    expect(() => assertId("1,2]")).toThrow();
    expect(() => assertId("")).toThrow();
  });
});

describe("htmlToText", () => {
  it("keeps line structure and shows where links really go", () => {
    const html =
      '<div>Darling, hi!<br><br>Click <a href="https://evil.example/login">https://bank.com</a> ' +
      'or <a href="mailto:kiliman@gmail.com">kiliman@gmail.com</a>.</div>' +
      '<p>Love&nbsp;always,<br>Michael</p><img alt="heart" src="x.png">' +
      "<style>.x{color:red}</style><script>alert(1)</script>";
    expect(htmlToText(html)).toBe(
      "Darling, hi!\n\nClick https://bank.com <https://evil.example/login> or kiliman@gmail.com.\n\n" +
        "Love always,\nMichael\n[image: heart]",
    );
  });

  it("decodes entities", () => {
    expect(htmlToText("I&#39;m &lt;here&gt; &amp; &#x1F970;")).toBe("I'm <here> & 🥰");
  });
});

describe("parseAuthentication", () => {
  const zoho =
    "mx.zohomail.com;\r\n\tdkim=pass;\r\n\tspf=pass (zohomail.com: domain of _spf.google.com designates 209.85.219.42 as permitted sender)  smtp.mailfrom=kiliman@gmail.com;\r\n\tarc=pass (i=1 dmarc=pass fromdomain=gmail.com);\r\n\tdmarc=pass(p=none dis=none)  header.from=gmail.com";

  it("reads Zoho's verdict", () => {
    const auth = parseAuthentication({ "Authentication-Results": [zoho] });
    expect(auth).toEqual({
      authservId: "mx.zohomail.com",
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
      dmarcDomain: "gmail.com",
    });
    expect(isAuthenticatedSender("kiliman@gmail.com", auth)).toBe(true);
    expect(isAuthenticatedSender("kiliman@evil.example", auth)).toBe(false);
  });

  it("ignores results a sender forged under another authserv-id", () => {
    const forged = "mail.attacker.example; dmarc=pass header.from=gmail.com; spf=pass";
    const failing = "mx.zohomail.com; dkim=none; spf=fail; dmarc=fail header.from=gmail.com";
    const auth = parseAuthentication({ "authentication-results": [forged, failing] });
    expect(auth.dmarc).toBe("fail");
    expect(isAuthenticatedSender("kiliman@gmail.com", auth)).toBe(false);
  });

  it("handles an address-style header.from and missing results", () => {
    const auth = parseAuthentication({
      "Authentication-Results": ["mx.zohomail.com; dmarc=pass header.from=<kiliman@gmail.com>"],
    });
    expect(auth.dmarcDomain).toBe("gmail.com");
    expect(parseAuthentication({}).dmarc).toBe("unknown");
  });
});

describe("decodeAddressList", () => {
  it("decodes Zoho's escaped addresses and drops the placeholder", () => {
    expect(decodeAddressList("&quot;Claudia&quot;&lt;claudia@iamclaudia.ai&gt;")).toBe(
      '"Claudia"<claudia@iamclaudia.ai>',
    );
    expect(decodeAddressList("Not Provided")).toBeNull();
  });
});
