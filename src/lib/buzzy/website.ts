/**
 * Read a public company website into a short card.
 * Proposed lines only — nothing here is a confirmed fact.
 * Private hosts are refused so this cannot be pointed at the internal network.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const WEBSITE_SOURCE = "from the website";

export type WebsiteLineKey = "name" | "does" | "serves" | "locations" | "voice";

export type WebsiteLine = {
  key: WebsiteLineKey;
  label: string;
  value: string;
};

const LABELS: Record<WebsiteLineKey, string> = {
  name: "Name",
  does: "What it does",
  serves: "Who it serves",
  locations: "Locations",
  voice: "How it describes itself",
};

const ORDER: WebsiteLineKey[] = ["name", "does", "serves", "locations", "voice"];

export type WebsiteRead =
  | { ok: true; page: string; lines: WebsiteLine[] }
  | { ok: false; error: string; code: "bad_url" | "blocked" | "unread" | "not_html" | "empty" | "redirects" };

const UNREAD = "BeeZilla couldn't open that website. Check the address and try again.";

export function normalizeWebsiteUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s || s.length > 300) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || !host.includes(".")) return null;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return null;
  }
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return null;
  u.hash = "";
  u.hostname = host;
  return u.toString();
}

/** The eight 16-bit groups of an IPv6 address, or null when it isn't one. */
function ipv6Groups(s: string): number[] | null {
  let v = s.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]!;
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (dotted) {
    const q = [dotted[2], dotted[3], dotted[4], dotted[5]].map(Number);
    if (q.some((n) => n > 255)) return null;
    v = dotted[1]! + (((q[0]! << 8) | q[1]!).toString(16)) + ":" + (((q[2]! << 8) | q[3]!).toString(16));
  }
  const halves = v.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return nums.some((n) => Number.isNaN(n)) ? null : nums;
}

/**
 * The IPv4 address an IPv6 one carries inside it: "::ffff:7f00:1" is 127.0.0.1 written the
 * way a URL parser writes it (the dotted form never survives it), and the older ways to
 * carry one (compatible, NAT64, 6to4) reach it just the same. Null when it carries none.
 */
function embeddedIpv4(v6: string): string | null {
  const g = ipv6Groups(v6);
  if (!g) return null;
  const v4 = (x: number, y: number) => `${x >> 8}.${x & 255}.${y >> 8}.${y & 255}`;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && (g[5] === 0xffff || g[5] === 0)) return v4(g[6]!, g[7]!); // ::ffff:a.b.c.d, ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return v4(g[6]!, g[7]!);             // 64:ff9b::a.b.c.d (NAT64)
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!);                                                                                       // 2002:a.b:c.d:: (6to4)
  return null;
}

export function isPrivateIp(ip: string): boolean {
  const whole = ip.toLowerCase();
  if (isIP(whole) === 6) {
    // An address that carries a private IPv4 address inside it is that address. (Looked at
    // before the "::ffff:" is cut off below, because a URL parser writes 127.0.0.1 inside
    // IPv6 as ::ffff:7f00:1, which that cut would leave unreadable.)
    const inner = embeddedIpv4(whole);
    if (inner && isPrivateIp(inner)) return true;
    if (/^2001:0*:/.test(whole)) return true; // Teredo 2001::/32 tunnels to anywhere
  }
  const v = whole.replace(/^::ffff:/, "");
  if (isIP(v) === 4) {
    const [a, b, c] = v.split(".").map((n) => Number(n));
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a === 169 && b === 254) return true; // link-local / cloud metadata 169.254.0.0/16
    if (a === 168 && b === 63 && c === 129 && Number(v.split(".")[3]) === 16) return true; // Azure's own service address
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24 + 192.0.2.0/24 (TEST-NET-1)
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmark)
    if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
    if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
    if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
    return false;
  }
  if (v === "::1" || v === "::") return true; // loopback + unspecified
  if (/^f[cd]/.test(v)) return true; // ULA fc00::/7
  if (/^fe[89ab]/.test(v)) return true; // link-local fe80::/10 (fe80–febf)
  if (/^fe[c-f]/.test(v)) return true; // site-local fec0::/10 (retired, still routed on some networks)
  if (/^ff/.test(v)) return true; // multicast ff00::/8
  return false;
}

/**
 * Private-address guard. Exported so every reader (webpage.ts, and anything
 * that follows redirects later) uses the SAME rule — a second copy is how an
 * SSRF check silently diverges.
 */
export async function hostBlocked(host: string): Promise<"blocked" | "missing" | "ok"> {
  // `new URL("https://[::1]/").hostname` keeps the brackets, and `isIP` does
  // not understand them — strip them or an IPv6 literal is treated as a name.
  const bare = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(bare) && isPrivateIp(bare)) return "blocked";
  try {
    const found = await lookup(bare, { all: true, verbatim: true });
    if (!found.length) return "missing";
    if (found.some((row) => isPrivateIp(row.address))) return "blocked";
    return "ok";
  } catch {
    return "missing";
  }
}

function clean(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex -- deliberate: matches control bytes so they can be stripped
  const t = s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim();
}

function decode(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => {
      const c = Number(n);
      return c > 0 && c < 65536 ? String.fromCharCode(c) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const c = parseInt(n, 16);
      return c > 0 && c < 65536 ? String.fromCharCode(c) : "";
    });
}

function attr(tag: string, name: string): string {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i");
  const m = tag.match(re);
  return decode((m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim());
}

function metaContent(html: string, key: string): string {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  const want = key.toLowerCase();
  for (const tag of tags) {
    const name = (attr(tag, "name") || attr(tag, "property")).toLowerCase();
    if (name !== want) continue;
    const content = attr(tag, "content").replace(/\s+/g, " ").trim();
    if (content) return content;
  }
  return "";
}

function textOf(fragment: string): string {
  return decode(fragment.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function stripScripts(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ");
}

function looksSensitive(s: string): boolean {
  return /\b(ein|ssn|tax id|routing number|account number|password|api key)\b/i.test(s);
}

function looksLikeChrome(s: string): boolean {
  return /cookie|privacy policy|sign in|subscribe|enable javascript|skip to content|accept all/i.test(s);
}

type Ld = Record<string, unknown>;

function flattenLd(node: unknown, acc: Ld[]): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) flattenLd(item, acc);
    return;
  }
  if (typeof node !== "object") return;
  const o = node as Ld;
  if (o["@graph"]) flattenLd(o["@graph"], acc);
  if (o["@type"]) acc.push(o);
}

function ldBlocks(html: string): Ld[] {
  const acc: Ld[] = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      flattenLd(JSON.parse(m[1]), acc);
    } catch {
      /* a broken block is not a fact */
    }
  }
  return acc;
}

function ldType(node: Ld): string {
  const t = node["@type"];
  if (Array.isArray(t)) return t.map((x) => String(x)).join(" ");
  return typeof t === "string" ? t : "";
}

function asText(v: unknown): string {
  if (typeof v === "string") return textOf(v);
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map((item) => asText(item)).filter(Boolean).join(", ");
  if (v && typeof v === "object") {
    const o = v as Ld;
    if (typeof o.name === "string") return textOf(o.name);
    if (typeof o.audienceType === "string") return textOf(o.audienceType);
  }
  return "";
}

function addressText(v: unknown): string {
  if (typeof v === "string") return v.replace(/\s+/g, " ").trim();
  if (!v || typeof v !== "object") return "";
  const o = v as Ld;
  const parts = [o.streetAddress, o.addressLocality, o.addressRegion]
    .map((p) => (typeof p === "string" ? p.trim() : ""))
    .filter(Boolean);
  return textOf(parts.join(", "));
}

function splitTitle(title: string): { brand: string; tag: string } {
  const parts = title
    .split(/\s*[|–—]\s*|\s+-\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return { brand: title.trim(), tag: "" };
  const sentence = (s: string) => s.length > 42 || s.split(" ").length > 6;
  const [a, b] = parts;
  if (sentence(a) && !sentence(b)) return { brand: b, tag: a };
  if (sentence(b) && !sentence(a)) return { brand: a, tag: b };
  return { brand: a, tag: b };
}

function pushLine(lines: WebsiteLine[], key: WebsiteLineKey, value: string, max: number) {
  const v = clean(value, max);
  if (v.length < (key === "name" ? 2 : 8)) return;
  if (looksSensitive(v) || looksLikeChrome(v)) return;
  const folded = v.toLowerCase();
  if (lines.some((l) => l.value.toLowerCase() === folded)) return;
  if (key !== "name" && lines.some((l) => l.key === "name" && folded === l.value.toLowerCase())) return;
  lines.push({ key, label: LABELS[key], value: v });
}

/** Lines the page itself states. Missing lines are omitted, not guessed. */
export function proposeWebsiteLines(html: string): WebsiteLine[] {
  const blocks = ldBlocks(html);
  const org = blocks.find((b) =>
    /organization|localbusiness|professionalservice|store|dentist|corporation|brand|medicalbusiness|foodestablishment/i.test(
      ldType(b),
    ),
  );
  const title = textOf((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  const split = splitTitle(title);
  const siteName = metaContent(html, "og:site_name");
  const description =
    (org ? asText(org.description) : "") ||
    metaContent(html, "description") ||
    metaContent(html, "og:description");
  const slogan = org ? asText(org.slogan) : "";
  const bare = stripScripts(html);
  const h1 = textOf((bare.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "");
  let paragraph = "";
  const pRe = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let pm: RegExpExecArray | null;
  while ((pm = pRe.exec(bare))) {
    const t = textOf(pm[1]);
    if (t.length >= 40 && !looksLikeChrome(t)) {
      paragraph = t;
      break;
    }
  }
  const lines: WebsiteLine[] = [];
  pushLine(lines, "name", (org ? asText(org.name) : "") || siteName || split.brand || h1, 80);
  pushLine(lines, "does", description || paragraph, 240);
  if (org) {
    const audience = asText(org.audience) || asText(org.audienceType);
    pushLine(lines, "serves", audience, 160);
    const area = asText(org.areaServed);
    const addr = addressText(org.address);
    const where = [addr, area].filter((part, i, all) => part && all.findIndex((x) => x.toLowerCase() === part.toLowerCase()) === i);
    pushLine(lines, "locations", where.join("; "), 180);
  }
  const addressTag = textOf((bare.match(/<address\b[^>]*>([\s\S]*?)<\/address>/i) || [])[1] || "");
  if (!lines.some((l) => l.key === "locations") && addressTag) {
    pushLine(lines, "locations", addressTag, 180);
  }
  const visible = textOf(bare).slice(0, 6000);
  if (!lines.some((l) => l.key === "serves")) {
    const sm = visible.match(
      /(?:we (?:help|serve|work with)|built for|made for|designed for|our (?:customers|clients|patients) (?:are|include))\s+([^.]{6,90})/i,
    );
    if (sm) pushLine(lines, "serves", sm[1], 160);
  }
  if (!lines.some((l) => l.key === "locations")) {
    const lm = visible.match(/(?:located in|based in|offices in)\s+([A-Z][^.]{2,80})/);
    if (lm) pushLine(lines, "locations", lm[1], 180);
  }
  pushLine(lines, "voice", slogan || split.tag || (h1 && h1 !== split.brand ? h1 : ""), 160);
  return ORDER.filter((key) => lines.some((l) => l.key === key)).map(
    (key) => lines.find((l) => l.key === key) as WebsiteLine,
  );
}

async function readHtml(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cap = 400_000;
  while (total < cap) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.byteLength;
  }
  try {
    await reader.cancel();
  } catch {
    /* stream already closed */
  }
  const buf = new Uint8Array(Math.min(total, cap));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, buf.length - offset);
    if (take <= 0) break;
    buf.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

export async function readPublicWebsite(raw: unknown): Promise<WebsiteRead> {
  const first = normalizeWebsiteUrl(raw);
  if (!first) {
    return { ok: false, error: "Paste the website, like yourbusiness.com.", code: "bad_url" };
  }
  let current = first;
  for (let hop = 0; hop < 4; hop += 1) {
    let host = "";
    try {
      host = new URL(current).hostname;
    } catch {
      return { ok: false, error: "Paste the website, like yourbusiness.com.", code: "bad_url" };
    }
    const gate = await hostBlocked(host);
    if (gate === "blocked") {
      return {
        ok: false,
        error: "BeeZilla only reads a public website, not a private address.",
        code: "blocked",
      };
    }
    if (gate === "missing") return { ok: false, error: UNREAD, code: "unread" };
    let res: Response;
    try {
      res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "BeeZilla company check",
        },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      return { ok: false, error: UNREAD, code: "unread" };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { ok: false, error: UNREAD, code: "unread" };
      const next = normalizeWebsiteUrl(new URL(loc, current).toString());
      if (!next) {
        return {
          ok: false,
          error: "BeeZilla only reads a public website, not a private address.",
          code: "blocked",
        };
      }
      current = next;
      continue;
    }
    if (!res.ok) return { ok: false, error: UNREAD, code: "unread" };
    const ctype = res.headers.get("content-type") || "";
    if (ctype && !/text\/html|application\/xhtml\+xml/i.test(ctype)) {
      return { ok: false, error: "That address isn't a web page BeeZilla can read.", code: "not_html" };
    }
    const html = await readHtml(res);
    if (!/<\s*html|<\s*body|<\s*title|<\s*p\b/i.test(html)) {
      return { ok: false, error: "That address isn't a web page BeeZilla can read.", code: "not_html" };
    }
    const lines = proposeWebsiteLines(html);
    if (!lines.length) {
      return {
        ok: false,
        error:
          "BeeZilla read that page but couldn't find a name or description to check. You can add the company by name instead.",
        code: "empty",
      };
    }
    return { ok: true, page: current, lines };
  }
  return { ok: false, error: "That website sent BeeZilla in a circle. Try the main page address.", code: "redirects" };
}

/** Tab label when the page never stated a name. Not a confirmed fact. */
export function fallbackCompanyName(page: string): string {
  try {
    return new URL(page).hostname.replace(/^www\./, "").slice(0, 80) || "New company";
  } catch {
    return "New company";
  }
}
