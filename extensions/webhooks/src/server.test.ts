import { beforeEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { parseWebhooksConfig } from "./config";
import { handleWebhookRequest, type WebhookHandlerDeps } from "./server";
import type { NewDelivery } from "./store";
import { WebhookStore } from "./store";
import { createRecordingLogger, createTestDb } from "./test-helpers";

const PATH_SECRET = "p".repeat(40);
const HMAC_SECRET = "github-signing-secret";
const ZOHO_SECRET = "zoho-handshake-secret";

function zohoSign(body: string, secret = ZOHO_SECRET): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

describe("handleWebhookRequest", () => {
  let store: WebhookStore;
  let accepted: NewDelivery[];
  let deps: WebhookHandlerDeps;
  let log: ReturnType<typeof createRecordingLogger>;

  beforeEach(() => {
    store = new WebhookStore(createTestDb());
    accepted = [];
    log = createRecordingLogger();
    deps = {
      config: parseWebhooksConfig({
        maxBodyBytes: 1024,
        hooks: {
          plain: { secret: PATH_SECRET },
          off: { secret: PATH_SECRET, enabled: false },
          github: {
            secret: PATH_SECRET,
            signature: {
              header: "x-hub-signature-256",
              secret: HMAC_SECRET,
              encoding: "hex",
              prefix: "sha256=",
            },
          },
          "zoho-mail": { secret: PATH_SECRET, signature: "zoho", target: "mail.handle_webhook" },
        },
      }),
      store,
      log,
      onAccepted: (delivery) => accepted.push(delivery),
      now: () => new Date("2026-10-24T18:00:00.000Z"),
    };
  });

  function post(path: string, body: string, headers: Record<string, string> = {}) {
    return handleWebhookRequest(
      new Request(`http://127.0.0.1:30089${path}`, {
        method: "POST",
        body,
        headers: { "content-type": "application/json", ...headers },
      }),
      deps,
    );
  }

  it("stores an unsigned delivery and answers 200 with its id", async () => {
    const res = await post(`/hook/plain/${PATH_SECRET}`, '{"hello":"world"}', {
      authorization: "Bearer should-not-be-stored",
      "x-request-id": "abc",
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };

    const stored = store.get(id);
    expect(stored?.body).toBe('{"hello":"world"}');
    expect(stored?.status).toBe("pending");
    expect(stored?.contentType).toBe("application/json");
    expect(stored?.headers["x-request-id"]).toBe("abc");
    expect(stored?.headers.authorization).toBeUndefined();
    expect(accepted.map((d) => d.id)).toEqual([id]);
  });

  it("answers 404 for a wrong secret, an unknown hook, a disabled hook and other paths", async () => {
    for (const path of [
      `/hook/plain/${"x".repeat(40)}`,
      `/hook/nope/${PATH_SECRET}`,
      `/hook/off/${PATH_SECRET}`,
      "/health",
      `/hook/plain`,
      `/hook/constructor/${PATH_SECRET}`,
    ]) {
      expect((await post(path, "{}")).status).toBe(404);
    }
    expect(store.counts().pending).toBe(0);
  });

  it("never logs the path secret", async () => {
    await post(`/hook/plain/${PATH_SECRET}`, "{}");
    await post(`/hook/plain/${"x".repeat(40)}`, "{}");
    expect(JSON.stringify(log.entries)).not.toContain(PATH_SECRET);
    expect(JSON.stringify(log.entries)).not.toContain("x".repeat(40));
  });

  it("rejects non-POST methods after authenticating", async () => {
    const res = await handleWebhookRequest(
      new Request(`http://127.0.0.1:30089/hook/plain/${PATH_SECRET}`),
      deps,
    );
    expect(res.status).toBe(405);
  });

  it("rejects an oversized body with 413", async () => {
    expect((await post(`/hook/plain/${PATH_SECRET}`, "x".repeat(2000))).status).toBe(413);
  });

  describe("hmac signature", () => {
    const body = '{"action":"opened"}';
    const good = `sha256=${createHmac("sha256", HMAC_SECRET).update(body).digest("hex")}`;

    it("accepts a valid signature", async () => {
      const res = await post(`/hook/github/${PATH_SECRET}`, body, { "x-hub-signature-256": good });
      expect(res.status).toBe(200);
    });

    it("rejects a missing, tampered or unprefixed signature", async () => {
      const path = `/hook/github/${PATH_SECRET}`;
      expect((await post(path, body)).status).toBe(401);
      expect((await post(path, `${body} `, { "x-hub-signature-256": good })).status).toBe(401);
      expect(
        (await post(path, body, { "x-hub-signature-256": good.replace("sha256=", "") })).status,
      ).toBe(401);
      expect(store.counts().pending).toBe(0);
    });
  });

  describe("zoho signature", () => {
    const path = `/hook/zoho-mail/${PATH_SECRET}`;

    it("learns the secret from the handshake, then requires signatures", async () => {
      const handshake = await post(path, "{}", { "x-hook-secret": ZOHO_SECRET });
      expect(handshake.status).toBe(200);
      expect(store.getSigningSecret("zoho-mail")).toBe(ZOHO_SECRET);

      const id = ((await handshake.json()) as { id: string }).id;
      expect(store.get(id)?.headers["x-hook-secret"]).toBeUndefined();

      const body = '{"messageId":1771234567890123456,"subject":"Hi"}';
      expect((await post(path, body, { "x-hook-signature": zohoSign(body) })).status).toBe(200);
      expect((await post(path, body)).status).toBe(401);
      expect((await post(path, body, { "x-hook-signature": zohoSign(body, "wrong") })).status).toBe(
        401,
      );
    });

    it("verifies a handshake that is also signed", async () => {
      const res = await post(path, "{}", {
        "x-hook-secret": ZOHO_SECRET,
        "x-hook-signature": zohoSign("{}", "not-the-offered-secret"),
      });
      expect(res.status).toBe(401);
      expect(store.getSigningSecret("zoho-mail")).toBeNull();
    });

    it("refuses an unsigned request before any handshake", async () => {
      expect((await post(path, "{}")).status).toBe(401);
    });

    it("refuses to replace a stored secret, but accepts the same one again", async () => {
      await post(path, "{}", { "x-hook-secret": ZOHO_SECRET });

      const swap = await post(path, "{}", { "x-hook-secret": "attacker-secret" });
      expect(swap.status).toBe(409);
      expect(store.getSigningSecret("zoho-mail")).toBe(ZOHO_SECRET);

      const same = await post(path, "{}", {
        "x-hook-secret": ZOHO_SECRET,
        "x-hook-signature": zohoSign("{}"),
      });
      expect(same.status).toBe(200);
    });

    it("accepts a new handshake after the secret is reset", async () => {
      await post(path, "{}", { "x-hook-secret": ZOHO_SECRET });
      store.forgetSigningSecret("zoho-mail");
      expect((await post(path, "{}", { "x-hook-secret": "fresh-secret" })).status).toBe(200);
      expect(store.getSigningSecret("zoho-mail")).toBe("fresh-secret");
    });
  });
});
