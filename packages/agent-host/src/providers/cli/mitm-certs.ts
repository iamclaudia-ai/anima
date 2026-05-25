/**
 * MITM certificate authority for the Claude CLI runtime (#33).
 *
 * The MITM transport (HTTPS_PROXY interception, the ANTHROPIC_BASE_URL-free
 * alternative) terminates TLS for api.anthropic.com with a leaf cert signed by a
 * local CA. The CLI trusts that CA via NODE_EXTRA_CA_CERTS — nothing is added to
 * the system keychain, and the trust applies only to processes Anima launches.
 *
 * Only one host is ever impersonated (api.anthropic.com), so a single static
 * leaf cert suffices — no dynamic per-host signing. Certs are generated once
 * with `openssl` and cached in ~/.anima/mitm/ (10-year validity).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MITM_DIR = join(homedir(), ".anima", "mitm");
const CA_KEY = join(MITM_DIR, "ca.key");
const CA_PEM = join(MITM_DIR, "ca.pem");
const LEAF_KEY = join(MITM_DIR, "leaf.key");
const LEAF_PEM = join(MITM_DIR, "leaf.pem");
const MITM_HOST = "api.anthropic.com";
const DAYS = "3650";

export interface MitmCerts {
  /** Path to the CA cert — goes in the CLI's NODE_EXTRA_CA_CERTS. */
  caPath: string;
  /** Leaf private key PEM (for the inner TLS server). */
  key: string;
  /** Leaf cert PEM (for the inner TLS server). */
  cert: string;
}

let cached: MitmCerts | null = null;

function openssl(args: string[]): void {
  execFileSync("openssl", args, { stdio: "ignore" });
}

/** True when the leaf cert exists and is not expiring within a day. */
function certsValid(): boolean {
  if (![CA_KEY, CA_PEM, LEAF_KEY, LEAF_PEM].every(existsSync)) return false;
  try {
    execFileSync("openssl", ["x509", "-checkend", "86400", "-noout", "-in", LEAF_PEM], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false; // expired or unreadable → regenerate
  }
}

function generate(): void {
  mkdirSync(MITM_DIR, { recursive: true });
  // CA
  openssl(["genrsa", "-out", CA_KEY, "2048"]);
  openssl([
    "req",
    "-x509",
    "-new",
    "-nodes",
    "-key",
    CA_KEY,
    "-sha256",
    "-days",
    DAYS,
    "-out",
    CA_PEM,
    "-subj",
    "/CN=Anima MITM CA",
  ]);
  // Leaf for api.anthropic.com, signed by the CA, with a SAN.
  const csr = join(MITM_DIR, "leaf.csr");
  openssl(["genrsa", "-out", LEAF_KEY, "2048"]);
  openssl(["req", "-new", "-key", LEAF_KEY, "-out", csr, "-subj", `/CN=${MITM_HOST}`]);
  openssl([
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    CA_PEM,
    "-CAkey",
    CA_KEY,
    "-CAcreateserial",
    "-out",
    LEAF_PEM,
    "-days",
    DAYS,
    "-sha256",
    // SAN + serverAuth EKU via an in-line extension file.
    "-extfile",
    writeExtFile(),
  ]);
}

/** Write the x509 extension file (SAN + serverAuth) and return its path. */
function writeExtFile(): string {
  const path = join(MITM_DIR, "leaf.ext");
  writeFileSync(path, `subjectAltName=DNS:${MITM_HOST}\nextendedKeyUsage=serverAuth\n`);
  return path;
}

/** Generate (once) or load the MITM CA + leaf certs. Cached for the process. */
export function ensureMitmCerts(): MitmCerts {
  if (cached) return cached;
  if (!certsValid()) generate();
  cached = {
    caPath: CA_PEM,
    key: readFileSync(LEAF_KEY, "utf8"),
    cert: readFileSync(LEAF_PEM, "utf8"),
  };
  return cached;
}
