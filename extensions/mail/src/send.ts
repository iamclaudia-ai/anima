/**
 * Outgoing mail (`mail.send`).
 *
 * Sending is a gateway method only: there is deliberately no MCP tool for it,
 * so the restricted `mail` profile (which reads untrusted mail) can never send.
 * Sessions with a shell send on Michael's request with `anima mail send`.
 *
 * Attachments are paths on the gateway host, read here and uploaded to Zoho's
 * store before the send.
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { ZohoAttachment, ZohoMailClient } from "./zoho";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** One address or a list, so the CLI can pass `--to a@b.com`. */
const addressList = z
  .union([z.email(), z.array(z.email()).min(1).max(20)])
  .transform((v) => (Array.isArray(v) ? v : [v]));

const pathList = z
  .union([z.string().min(1), z.array(z.string().min(1)).max(10)])
  .transform((v) => (Array.isArray(v) ? v : [v]));

export const sendSchema = z.object({
  to: addressList,
  cc: addressList.optional(),
  bcc: addressList.optional(),
  subject: z
    .string()
    .min(1)
    .max(300)
    .transform((s) => s.replace(/[\r\n]+/g, " ").trim()),
  body: z.string().min(1),
  format: z.enum(["plaintext", "html"]).default("plaintext"),
  attachments: pathList
    .optional()
    .describe("Absolute paths on the gateway host (~/ allowed), up to 10 files"),
  replyTo: z
    .string()
    .regex(/^\d{1,25}$/, "a Zoho message id (digits)")
    .optional()
    .describe("Send as a reply to this message, in its thread"),
});

export type SendParams = z.infer<typeof sendSchema>;

export interface SendResult {
  sent: true;
  messageId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  replyTo: string | null;
  attachments: Array<{ name: string; bytes: number }>;
}

interface LocalFile {
  path: string;
  name: string;
  bytes: number;
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** Check every attachment before uploading any, so a bad path sends nothing. */
export async function checkAttachments(paths: string[]): Promise<LocalFile[]> {
  const files: LocalFile[] = [];
  let total = 0;
  for (const raw of paths) {
    const path = expandHome(raw);
    if (!isAbsolute(path)) {
      throw new Error(`Attachment path must be absolute (it is read on the gateway host): ${raw}`);
    }
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new Error(`Attachment is not a file: ${raw}`);
    if (info.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment is larger than 20 MB: ${raw}`);
    }
    total += info.size;
    files.push({ path, name: basename(path), bytes: info.size });
  }
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error("Attachments total more than 25 MB");
  }
  return files;
}

export async function sendMail(client: ZohoMailClient, params: SendParams): Promise<SendResult> {
  const files = await checkAttachments(params.attachments ?? []);
  const uploaded: ZohoAttachment[] = [];
  for (const file of files) {
    uploaded.push(await client.uploadAttachment(file.name, Bun.file(file.path)));
  }

  const cc = params.cc ?? [];
  const bcc = params.bcc ?? [];
  const { messageId } = await client.sendMessage(
    {
      toAddress: params.to.join(","),
      ...(cc.length ? { ccAddress: cc.join(",") } : {}),
      ...(bcc.length ? { bccAddress: bcc.join(",") } : {}),
      subject: params.subject,
      content: params.body,
      mailFormat: params.format,
      ...(uploaded.length ? { attachments: uploaded } : {}),
    },
    params.replyTo,
  );

  return {
    sent: true,
    messageId,
    to: params.to,
    cc,
    bcc,
    subject: params.subject,
    replyTo: params.replyTo ?? null,
    attachments: files.map((f) => ({ name: f.name, bytes: f.bytes })),
  };
}
