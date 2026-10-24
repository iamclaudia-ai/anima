/**
 * Parsing helpers for Zoho Mail data: lossless JSON, HTML → readable text, and
 * the authentication verdict Zoho's MX stamps on every incoming message.
 */

/**
 * Parse JSON, keeping integers too big for a JS number as strings.
 *
 * Zoho message and folder ids are 18–19 digit longs (`1792870955365152800`),
 * which `JSON.parse` silently rounds. Integers of 16+ digits outside strings are
 * quoted first. The scan tracks string state, because subjects and summaries
 * are sender-controlled and may contain digit runs of their own.
 */
export function parseJsonLossless<T = unknown>(text: string): T {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let j = i + 1;
      while (j < text.length && /[0-9.eE+-]/.test(text[j])) j++;
      const token = text.slice(i, j);
      out += /^-?\d{16,}$/.test(token) ? `"${token}"` : token;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return JSON.parse(out) as T;
}

/** A Zoho id: digits only. Guards every id we splice into a URL or a raw JSON body. */
export function assertId(value: string, what = "id"): string {
  if (!/^\d{1,25}$/.test(value)) throw new Error(`Invalid ${what}: ${value}`);
  return value;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
  reg: "®",
  trade: "™",
  zwnj: "",
  zwj: "",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower in NAMED_ENTITIES) return NAMED_ENTITIES[lower];
    if (lower.startsWith("#x")) return safeCodePoint(Number.parseInt(lower.slice(2), 16), match);
    if (lower.startsWith("#")) return safeCodePoint(Number.parseInt(lower.slice(1), 10), match);
    return match;
  });
}

function safeCodePoint(code: number, fallback: string): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/**
 * Convert an email's HTML to readable plain text.
 *
 * Links keep their real destination (`text <https://…>`) so a mismatch between
 * what a link says and where it goes stays visible. Images become `[image: alt]`.
 */
// Stand-ins for the angle brackets around a link's destination, so the final
// tag strip can't mistake `<https://…>` for markup and delete it.
const OPEN = "\u0001";
const CLOSE = "\u0002";

export function htmlToText(html: string): string {
  let text = html
    .replaceAll(OPEN, "")
    .replaceAll(CLOSE, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, "")
    .replace(
      /<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi,
      (_m, _q, dq, sq, inner) => {
        // Entities stay encoded until the final decode; compare decoded forms.
        const rawHref = String(dq ?? sq ?? "")
          .replace(/[<>]/g, "")
          .trim();
        const href = decodeEntities(rawHref);
        const label = String(inner)
          .replace(/<[^>]+>/g, "")
          .trim();
        const plainLabel = decodeEntities(label);
        if (!href || href.startsWith("#")) return label;
        if (!plainLabel || plainLabel === href || `mailto:${plainLabel}` === href) {
          return rawHref.replace(/^mailto:/, "");
        }
        return `${label} ${OPEN}${rawHref}${CLOSE}`;
      },
    )
    .replace(/<img\b[^>]*?alt\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi, (_m, _q, dq, sq) => {
      const alt = String(dq ?? sq ?? "").trim();
      return alt ? `[image: ${decodeEntities(alt)}]` : "";
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/(p|div|tr|h[1-6]|blockquote|li|ul|ol|table|section|article)>/gi, "\n")
    .replace(/<(p|h[1-6]|blockquote|table|section|article)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, "");

  text = decodeEntities(text)
    .replaceAll(OPEN, "<")
    .replaceAll(CLOSE, ">")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/[ \t ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export type AuthVerdict =
  | "pass"
  | "fail"
  | "none"
  | "neutral"
  | "softfail"
  | "temperror"
  | "permerror"
  | "unknown";

export interface Authentication {
  /** The authserv-id the results came from; only Zoho's own MX is trusted. */
  authservId: string | null;
  spf: AuthVerdict;
  dkim: AuthVerdict;
  dmarc: AuthVerdict;
  /** Domain DMARC evaluated (`header.from=`), lowercased. */
  dmarcDomain: string | null;
}

const TRUSTED_AUTHSERV = /^mx\.zohomail\.com$/i;

function verdict(results: string, method: string): AuthVerdict {
  const match = new RegExp(`(?:^|[;\\s])${method}=([a-z]+)`, "i").exec(results);
  return (match?.[1]?.toLowerCase() as AuthVerdict | undefined) ?? "none";
}

/**
 * Read the authentication verdict from the topmost `Authentication-Results`
 * header stamped by Zoho's MX. Headers a sender added themselves sit below it
 * and carry their own authserv-id, so they are ignored.
 */
export function parseAuthentication(headers: Record<string, string[]>): Authentication {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === "authentication-results");
  const values = key ? headers[key] : [];
  for (const raw of values) {
    const unfolded = raw.replace(/\r?\n[ \t]+/g, " ").trim();
    const authservId = unfolded.split(";")[0]?.trim() ?? "";
    if (!TRUSTED_AUTHSERV.test(authservId)) continue;
    // header.from is a bare domain (`gmail.com`) or an address (`<kiliman@gmail.com>`).
    const dmarcDomain = /dmarc=[a-z]+[^;]*?header\.from=<?(?:[^>\s;@]+@)?([a-z0-9.-]+)>?/i.exec(
      unfolded,
    );
    return {
      authservId,
      spf: verdict(unfolded, "spf"),
      dkim: verdict(unfolded, "dkim"),
      dmarc: verdict(unfolded, "dmarc"),
      dmarcDomain: dmarcDomain?.[1]?.toLowerCase() ?? null,
    };
  }
  return { authservId: null, spf: "unknown", dkim: "unknown", dmarc: "unknown", dmarcDomain: null };
}

/**
 * True when the From address is cryptographically backed: DMARC passed at
 * Zoho's MX for the From address's own domain.
 */
export function isAuthenticatedSender(fromAddress: string, auth: Authentication): boolean {
  const domain = fromAddress.split("@")[1]?.toLowerCase();
  return Boolean(domain) && auth.dmarc === "pass" && auth.dmarcDomain === domain;
}

/** `&quot;Claudia&quot;&lt;claudia@iamclaudia.ai&gt;` → `"Claudia"<claudia@iamclaudia.ai>` */
export function decodeAddressList(value: string | undefined): string | null {
  if (!value || value === "Not Provided") return null;
  return decodeEntities(value);
}
