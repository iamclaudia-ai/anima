/**
 * Inbound webhook listener: POST /hook/<name>/<secret>.
 *
 * Order of checks, each one failing closed:
 *   1. the path names an enabled hook and carries its secret (else 404, so a
 *      prober can't tell a wrong secret from a missing hook);
 *   2. POST only (405), body within the size cap (413);
 *   3. the signature, when the hook has one configured (401, or 409 when a
 *      sender offers a new signing secret while one is already stored);
 *   4. the delivery is written to the inbox, and only then answered with 200.
 *
 * The URL carries a secret, so nothing here ever logs it — hook names only.
 */

import { randomUUID } from "node:crypto";
import type { LoggerLike } from "@anima/shared";
import type { WebhooksConfig } from "./config";
import {
  ZOHO_SECRET_HEADER,
  ZOHO_SIGNATURE_HEADER,
  secretsEqual,
  verifyHmac,
  verifyZoho,
} from "./signature";
import type { NewDelivery, WebhookStore } from "./store";

/** Headers never written to the inbox: credentials and in-band secrets. */
const DROPPED_HEADERS = new Set([ZOHO_SECRET_HEADER, "authorization", "cookie"]);

/** Compared against when the hook doesn't exist, so the miss costs the same. */
const DUMMY_SECRET = randomUUID() + randomUUID();

const HOOK_PATH = /^\/hook\/([^/]+)\/([^/]+)\/?$/;

export interface WebhookHandlerDeps {
  config: WebhooksConfig;
  store: WebhookStore;
  log: LoggerLike;
  /** Called after a delivery is safely stored and before the response is sent. */
  onAccepted(delivery: NewDelivery): void;
  now?: () => Date;
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

const notFound = () => json(404, { ok: false, error: "not found" });

export async function handleWebhookRequest(
  req: Request,
  deps: WebhookHandlerDeps,
): Promise<Response> {
  const { config, store, log } = deps;
  const match = HOOK_PATH.exec(new URL(req.url).pathname);
  if (!match) return notFound();

  const [, name, pathSecret] = match;
  const hook = Object.hasOwn(config.hooks, name) ? config.hooks[name] : undefined;
  const secretOk = secretsEqual(pathSecret, hook?.secret ?? DUMMY_SECRET);
  if (!hook || !hook.enabled || !secretOk) {
    if (hook) log.warn("Rejected webhook with a wrong path secret", { hook: name });
    return notFound();
  }

  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });

  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (declaredLength > config.maxBodyBytes) {
    return json(413, { ok: false, error: "body too large" });
  }
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.byteLength > config.maxBodyBytes) {
    return json(413, { ok: false, error: "body too large" });
  }

  const now = (deps.now ?? (() => new Date()))().toISOString();
  let learnedSecret: string | null = null;

  if (hook.signature === "zoho") {
    const stored = store.getSigningSecret(name);
    const offered = req.headers.get(ZOHO_SECRET_HEADER);
    if (stored && offered && !secretsEqual(offered, stored)) {
      log.warn(
        "Webhook offered a new signing secret while one is stored; " +
          "run webhooks.reset_signing_secret to accept it",
        { hook: name },
      );
      return json(409, { ok: false, error: "signing secret already set" });
    }
    const secret = stored ?? offered;
    if (!secret) {
      log.warn("Webhook has no signing secret yet and none was offered", { hook: name });
      return json(401, { ok: false, error: "invalid signature" });
    }
    const signature = req.headers.get(ZOHO_SIGNATURE_HEADER);
    // The handshake request may arrive unsigned; every later one must be signed.
    const handshake = !stored && offered !== null;
    if (signature ? !verifyZoho(secret, signature, body) : !handshake) {
      log.warn("Rejected webhook with an invalid signature", { hook: name });
      return json(401, { ok: false, error: "invalid signature" });
    }
    if (!stored) learnedSecret = secret;
  } else if (hook.signature) {
    if (!verifyHmac(hook.signature, req.headers.get(hook.signature.header), body)) {
      log.warn("Rejected webhook with an invalid signature", { hook: name });
      return json(401, { ok: false, error: "invalid signature" });
    }
  }

  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    if (!DROPPED_HEADERS.has(key.toLowerCase())) headers[key.toLowerCase()] = value;
  });

  const delivery: NewDelivery = {
    id: randomUUID(),
    hook: name,
    receivedAt: now,
    contentType: req.headers.get("content-type"),
    headers,
    body: new TextDecoder().decode(body),
  };

  try {
    store.insert(delivery);
    if (learnedSecret && store.learnSigningSecret(name, learnedSecret, now)) {
      log.info("Learned signing secret from handshake", { hook: name });
    }
  } catch (error) {
    log.error("Failed to store webhook delivery", { hook: name, error: String(error) });
    return json(500, { ok: false, error: "storage failed" });
  }

  log.info("Accepted webhook", { hook: name, id: delivery.id, bytes: body.byteLength });
  deps.onAccepted(delivery);
  return json(200, { ok: true, id: delivery.id });
}

export function startWebhookServer(deps: WebhookHandlerDeps): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: deps.config.host,
    port: deps.config.port,
    // Bun's own cap; the handler enforces the configured one with a clear 413.
    maxRequestBodySize: deps.config.maxBodyBytes + 64 * 1024,
    fetch: (req) => handleWebhookRequest(req, deps),
    error(error) {
      deps.log.error("Webhook server error", { error: String(error) });
      return json(500, { ok: false, error: "internal error" });
    },
  });
}
