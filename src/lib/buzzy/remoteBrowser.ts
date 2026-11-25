/**
 * The server browser — what a "Browser use" node on the Idea Board shows and records.
 *
 * Owner, 2026-11-21: "you should be able to record yourself using the browser in order to
 * accomplish the task at hand. But the browser it pulls up should be via a non-residential
 * IP, so you can see it as the AI would see it."
 *
 * So the browser here is NOT the person's own: it is a real Chromium on a server (the
 * managed cloud browser BeeZilla already uses to read pages, docs/TOOL-AND-BROWSER-PLAN.md
 * D3 — no proxy, so it goes out from a data-centre address like the AI's does). This
 * server drives it over the DevTools protocol and does three things for the person:
 *
 *   1. shows it: the page is streamed to them as pictures (a screencast), so what they see
 *      is the page as that server's address gets it, not as their home connection does;
 *   2. lets them use it: their clicks, typing and scrolling are passed on as real input;
 *   3. records it, if they asked: every click, line typed, key and scroll becomes a step in
 *      plain words with enough to find the same thing again. Those steps are what the
 *      node does — BeeZilla is handed them, and "Watch it run" plays them back here.
 *
 * Nothing here trusts the page. Page text only ever comes back as data (a button's name, a
 * field's label) and is trimmed and stripped before it becomes a step. What is typed into
 * a password, card or one-time-code field is passed on but never written down.
 *
 * Where the browser comes from (providers):
 *   - hyperbrowser: BZ_HYPERBROWSER_KEY — a fresh cloud session per recording, no proxy.
 *   - cdp:          BZ_BROWSER_CDP_URL  — any browser that exposes a DevTools address
 *                   (a browser container of your own, or a browser started for tests).
 *   BZ_BROWSER_PROVIDER picks one when both are set; otherwise hyperbrowser wins.
 *
 * Limits (a browser costs money while it is open): one browser per person, closed after
 * BZ_BROWSER_IDLE_SECONDS without input (default 240) and BZ_BROWSER_SESSION_SECONDS in all
 * (default 1200). The seconds are counted against the plan (entitlements.ts, scope "browser").
 *
 * The sessions live in this process. Run more than one server copy and a person's calls
 * must reach the same copy (a sticky route), or the second copy answers "no such browser".
 */
import { createHash, randomBytes } from "node:crypto";
import { promises as dnsPromises } from "node:dns";
import { readFile, unlink } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { isIP } from "node:net";
import { CdpConnection } from "./cdp";
import { isPrivateIp } from "./website";
import { MAX_STEPS, cleanSteps, cleanUrl, isRecordedKey, plain, stripSecretQuery, tidy, type BrowserMode, type BrowserStep, type ElementHint, type RunFile } from "./boardNodes";
import { MAX_DOWNLOAD_BYTES, decodeDataUrl, readZipEntry, safeContentType, safeFileName } from "./browserFiles";

export const VIEW_W = 1280;
export const VIEW_H = 800;

const env = (k: string) => (process.env[k] ?? "").trim();
const seconds = (k: string, dflt: number) => {
  const n = Number(env(k));
  return Number.isFinite(n) && n >= 10 ? n : dflt;
};
export const idleSeconds = () => seconds("BZ_BROWSER_IDLE_SECONDS", 240);
export const sessionSeconds = () => seconds("BZ_BROWSER_SESSION_SECONDS", 1200);

export class BrowserError extends Error {
  constructor(readonly code: "not_configured" | "start_failed" | "gone" | "busy" | "bad_request" | "quota" | "unavailable", message: string) {
    super(message);
  }
}

// ── Where the browser comes from ───────────────────────────────────────────

export type ProviderKind = "hyperbrowser" | "cdp";
export interface ProviderHandle {
  kind: ProviderKind;
  label: string;
  wsUrl: string;
  close(): Promise<void>;
  /** Where the browser itself saves a download ("" = it doesn't: the bytes are read here instead). */
  downloadDir?: string;
  /** A download the browser saved itself, read back by the name it was saved under (its guid). */
  savedDownload?(guid: string): Promise<Buffer | null>;
  /** The sign-ins this browser starts with and keeps (Hyperbrowser: a profile of the person's own). */
  keepsSignIns?: boolean;
}

export function providerKind(): ProviderKind | null {
  const want = env("BZ_BROWSER_PROVIDER").toLowerCase();
  if (want === "cdp" && env("BZ_BROWSER_CDP_URL")) return "cdp";
  if (want === "hyperbrowser" && env("BZ_HYPERBROWSER_KEY")) return "hyperbrowser";
  if (env("BZ_HYPERBROWSER_KEY")) return "hyperbrowser";
  if (env("BZ_BROWSER_CDP_URL")) return "cdp";
  return null;
}
export const browserConfigured = () => providerKind() !== null;

const hbBase = () => (env("BZ_HYPERBROWSER_BASE") || "https://api.hyperbrowser.ai/api").replace(/\/+$/, "");

const hbHeaders = () => ({ "content-type": "application/json", "x-api-key": env("BZ_HYPERBROWSER_KEY") });
/** Keep what the person signs in to between browsers (BZ_BROWSER_KEEP_SIGNINS=0 turns it off for the deployment). */
const keepSignIns = () => env("BZ_BROWSER_KEEP_SIGNINS") !== "0";
/** Block ads and their pop-ups in BeeZilla's browser (BZ_BROWSER_ADBLOCK=0 turns that off). */
const blockAds = () => env("BZ_BROWSER_ADBLOCK") !== "0";
/** The ad networks whose pop-ups cover a page's own buttons, for a browser of your own. */
export const AD_HOSTS = [
  "*doubleclick.net*", "*googlesyndication.com*", "*googleadservices.com*", "*adservice.google.*", "*googletagservices.com*",
  "*google-analytics.com/*collect*", "*amazon-adsystem.com*", "*adnxs.com*", "*taboola.com*", "*outbrain.com*", "*criteo.*",
  "*pubmatic.com*", "*rubiconproject.com*", "*openx.net*", "*casalemedia.com*", "*smartadserver.com*", "*adform.net*",
  "*moatads.com*", "*quantserve.com*", "*scorecardresearch.com*", "*zedo.com*", "*media.net/*", "*yieldmo.com*",
  "*sharethrough.com*", "*teads.tv*", "*3lift.com*", "*adsrvr.org*", "*bidswitch.net*", "*indexww.com*", "*fundingchoicesmessages.google.com*",
];
/** Where the cloud browser saves a download, inside its own machine (its documentation's folder). */
const hbDownloads = () => env("BZ_HYPERBROWSER_DOWNLOAD_DIR") || "/tmp/downloads";

// ── Staying signed in ──────────────────────────────────────────────────────
//
// Owner, 2026-11-23: a site "which can only be used via browser use like [a music]
// subscription" has to work "seamlessly" in a workflow — so BeeZilla's browser must still be
// signed in the next time it goes there. The person signs in once, themselves, in the browser
// window (BeeZilla never types a password); the browser keeps the cookies:
//   - hyperbrowser: a profile of the person's own on the provider (saved when a session stops,
//     docs.hyperbrowser.ai/sessions/profiles). Nothing about it is stored here: it is found
//     again by a name made from a hash of the account id.
//   - cdp: the cookies of the person's browser context, kept in this process's memory for
//     JAR_HOURS (a browser of your own has no profiles); a restart forgets them.
// "Forget sign-ins" (the window) deletes the profile or the cookies at once.

const profileIds = new Map<string, string>();
const profileName = (userId: string) => "beezilla-" + createHash("sha256").update("bz-browser-profile:" + userId).digest("hex").slice(0, 32);

async function findProfile(userId: string): Promise<string | null> {
  const cached = profileIds.get(userId);
  if (cached) return cached;
  const name = profileName(userId);
  const r = await fetch(`${hbBase()}/profiles?name=${encodeURIComponent(name)}`, { headers: hbHeaders(), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`profiles ${r.status}`);
  const j = (await r.json()) as Record<string, unknown> | unknown[];
  const list = (Array.isArray(j) ? j : ((j as Record<string, unknown>).profiles ?? (j as Record<string, unknown>).data ?? (j as Record<string, unknown>).items ?? [])) as Array<Record<string, unknown>>;
  const hit = Array.isArray(list) ? list.find((p) => p && p.name === name && p.id) : undefined;
  if (!hit) return null;
  profileIds.set(userId, String(hit.id));
  return String(hit.id);
}
async function hyperbrowserProfile(userId: string): Promise<string | null> {
  const found = await findProfile(userId);
  if (found) return found;
  const r = await fetch(`${hbBase()}/profile`, { method: "POST", headers: hbHeaders(), body: JSON.stringify({ name: profileName(userId) }), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`profile ${r.status}`);
  const id = String(((await r.json()) as Record<string, unknown>).id ?? "");
  if (!id) throw new Error("profile without an id");
  profileIds.set(userId, id);
  return id;
}

const JAR_HOURS = 12;
const cookieJar = new Map<string, { cookies: unknown[]; at: number }>();
function jarFor(userId: string): unknown[] | null {
  const j = cookieJar.get(userId);
  if (!j) return null;
  if (Date.now() - j.at > JAR_HOURS * 3600_000) { cookieJar.delete(userId); return null; }
  return j.cookies;
}

/** Does BeeZilla's browser keep sign-ins for this person (a profile, or cookies in memory)? */
export async function signInsKept(userId: string): Promise<boolean> {
  if (!keepSignIns()) return false;
  if (providerKind() === "hyperbrowser") {
    try { return !!(await findProfile(userId)); } catch { return false; }
  }
  return !!jarFor(userId)?.length;
}

/** Forget every site the person signed in to in BeeZilla's browser. */
export async function forgetSignIns(userId: string): Promise<boolean> {
  cookieJar.delete(userId);
  // A browser open now forgets at once (and keeps nothing when it closes).
  const open = currentBrowserSession(userId);
  if (open) await open.forgetNow();
  if (providerKind() !== "hyperbrowser") return true;
  let id: string | null = null;
  try { id = await findProfile(userId); } catch { return false; }
  profileIds.delete(userId);
  if (!id) return true;
  try {
    const r = await fetch(`${hbBase()}/profile/${encodeURIComponent(id)}`, { method: "DELETE", headers: hbHeaders(), signal: AbortSignal.timeout(10_000) });
    return r.ok || r.status === 404;
  } catch {
    return false;
  }
}

async function openHyperbrowser(userId: string): Promise<ProviderHandle> {
  const headers = hbHeaders();
  let profile: string | null = null;
  if (keepSignIns()) {
    try { profile = await hyperbrowserProfile(userId); } catch (e) { console.warn("[buzzy/browser] no profile:", (e as Error).message); }
  }
  // A fixed address of the deployment's own (a Hyperbrowser static IP): every recording and every
  // run of every node goes out from the same one. Without it: no proxy, the provider's data-centre
  // address, the same as the page reader the AI already uses (browser.ts). That is the point of this browser.
  const staticIp = env("BZ_HYPERBROWSER_STATIC_IP_ID");
  const make = (withProfile: boolean) => ({
    useProxy: !!staticIp,
    ...(staticIp ? { staticIpId: staticIp } : {}),
    // Ads and pop-ups in front of a page's own buttons stop a job (seen on a real text-to-speech
    // site, 2026-11-23: a full-height ad over its Download button): the provider blocks them.
    ...(blockAds() ? { adblock: true, annoyances: true } : {}),
    saveDownloads: true,
    timeoutMinutes: Math.min(720, Math.ceil(sessionSeconds() / 60) + 2),
    ...(withProfile && profile ? { profile: { id: profile, persistChanges: true } } : {}),
  });
  let res: Response;
  try {
    res = await fetch(`${hbBase()}/session`, { method: "POST", headers, body: JSON.stringify(make(true)), signal: AbortSignal.timeout(30_000) });
    // A profile the provider won't take (gone, or not in this plan) must not stop the browser opening.
    if (!res.ok && profile && res.status >= 400 && res.status < 500) {
      console.warn("[buzzy/browser] session with a profile refused:", res.status);
      profile = null;
      res = await fetch(`${hbBase()}/session`, { method: "POST", headers, body: JSON.stringify(make(false)), signal: AbortSignal.timeout(30_000) });
    }
  } catch {
    throw new BrowserError("start_failed", "BeeZilla couldn't reach the browser service. Try again in a moment.");
  }
  if (!res.ok) throw new BrowserError("start_failed", `The browser service said no (${res.status}). Try again in a moment.`);
  let j: Record<string, unknown>;
  try { j = (await res.json()) as Record<string, unknown>; } catch { j = {}; }
  const id = String(j.id ?? j.sessionId ?? "");
  const ws = String(j.wsEndpoint ?? j.ws_endpoint ?? j.websocketUrl ?? "");
  if (!id || !/^wss?:\/\//i.test(ws)) throw new BrowserError("start_failed", "The browser service answered in a way BeeZilla didn't expect.");
  let zip: { at: number; bytes: Buffer } | null = null;
  return {
    kind: "hyperbrowser",
    label: "A cloud browser on a server",
    wsUrl: ws,
    downloadDir: hbDownloads(),
    keepsSignIns: !!profile,
    // The session's downloads, zipped by the provider as they arrive (docs: "synced in real-time").
    savedDownload: async (guid: string) => {
      for (let i = 0; i < 12; i++) {
        if (!zip || Date.now() - zip.at > 3000) {
          const r = await fetch(`${hbBase()}/session/${encodeURIComponent(id)}/downloads-url`, { headers, signal: AbortSignal.timeout(10_000) });
          const d = r.ok ? ((await r.json()) as { status?: string; downloadsUrl?: string | null }) : {};
          // The provider's own storage link (https; a stand-in on this machine in tests).
          if (d.status === "completed" && d.downloadsUrl && (/^https:\/\//i.test(d.downloadsUrl) || (allowPrivate() && /^http:\/\/127\.0\.0\.1[:/]/.test(d.downloadsUrl)))) {
            const z = await fetch(d.downloadsUrl, { signal: AbortSignal.timeout(30_000) });
            const len = Number(z.headers.get("content-length") || 0);
            if (z.ok && len <= MAX_DOWNLOAD_BYTES * 4) zip = { at: Date.now(), bytes: Buffer.from(await z.arrayBuffer()) };
          } else if (d.status === "failed" || d.status === "not_enabled") return null;
        }
        const got = zip ? readZipEntry(zip.bytes, guid) : null;
        if (got) return got;
        await new Promise((r) => setTimeout(r, 2500));
      }
      return null;
    },
    close: async () => {
      try { await fetch(`${hbBase()}/session/${encodeURIComponent(id)}/stop`, { method: "PUT", headers, signal: AbortSignal.timeout(10_000) }); } catch { /* it times out on its own */ }
    },
  };
}

async function openCdpBrowser(): Promise<ProviderHandle> {
  const raw = env("BZ_BROWSER_CDP_URL");
  let ws = raw;
  if (/^https?:\/\//i.test(raw)) {
    let version: Record<string, unknown>;
    try {
      const r = await fetch(`${raw.replace(/\/+$/, "")}/json/version`, { signal: AbortSignal.timeout(8000) });
      version = (await r.json()) as Record<string, unknown>;
    } catch {
      throw new BrowserError("start_failed", "BeeZilla couldn't reach its browser. Try again in a moment.");
    }
    const found = String(version.webSocketDebuggerUrl ?? "");
    if (!found) throw new BrowserError("start_failed", "That browser did not offer a DevTools address.");
    // A browser names itself 127.0.0.1 or 0.0.0.0; the address we were given is the real one.
    const base = new URL(raw);
    const w = new URL(found);
    w.hostname = base.hostname;
    w.port = base.port;
    w.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    ws = w.toString();
  }
  if (!/^wss?:\/\//i.test(ws)) throw new BrowserError("not_configured", "BZ_BROWSER_CDP_URL has to be a DevTools address.");
  // One page's address would put every person in the same page: it has to be the browser's.
  if (/\/devtools\/page\//.test(ws)) throw new BrowserError("not_configured", "BZ_BROWSER_CDP_URL has to be a browser's address, not one page's.");
  // A browser on this machine (or one sharing a folder with it) can save downloads where this
  // server reads them back; any other is told to save nothing, and the bytes are read through it.
  const dir = env("BZ_BROWSER_DOWNLOAD_DIR");
  return {
    kind: "cdp", label: "A browser on a server", wsUrl: ws, close: async () => {},
    downloadDir: dir,
    keepsSignIns: keepSignIns(),
    savedDownload: dir ? async (guid: string) => {
      if (!/^[0-9a-f-]{8,64}$/i.test(guid)) return null;
      const path = joinPath(dir, guid);
      try { const b = await readFile(path); void unlink(path).catch(() => {}); return b.length <= MAX_DOWNLOAD_BYTES ? b : null; } catch { return null; }
    } : undefined,
  };
}

async function openProvider(userId: string): Promise<ProviderHandle> {
  const kind = providerKind();
  if (kind === "hyperbrowser") return openHyperbrowser(userId);
  if (kind === "cdp") return openCdpBrowser();
  throw new BrowserError("not_configured", "The server browser isn't set up on this BeeZilla yet.");
}

// ── What the person is told about where it runs ────────────────────────────

export interface Where {
  label: string;
  ip?: string;
  org?: string;
  kind?: "datacenter" | "home" | "unknown";
  /** One plain sentence for the window. */
  line: string;
}

const DATACENTER = /amazon|aws|google|gcp|microsoft|azure|digitalocean|hetzner|ovh|linode|akamai|cloudflare|oracle|vultr|contabo|scaleway|leaseweb|ionos|rackspace|alibaba|tencent|choopa|m247|datacamp|hosting|hoster|cloud|server|datacent|colo|vps|fly\.io|railway|heroku|netcup|upcloud|equinix|packet|zenlayer|psychz|quadranet|serverius|ovhcloud|kamatera|hostinger|godaddy|ramnode|buyvm|frantech|cdn77|stackpath|fastly|zscaler|nforce|worldstream|webzilla/i;
const HOME = /comcast|xfinity|spectrum|charter|verizon|at&t|\batt\b|cox comm|centurylink|lumen|frontier|optimum|altice|windstream|sky broadband|\bbt\b|virgin media|talktalk|telekom|vodafone|orange|telefonica|movistar|rogers|bell canada|telus|shaw|t-mobile|sprint|cellular|mobile|broadband|\bdsl\b|cable|fiber|fibre|telecom|internet service|residential|wireless/i;

export function classifyOrg(org: string): "datacenter" | "home" | "unknown" {
  if (DATACENTER.test(org)) return "datacenter";
  if (HOME.test(org)) return "home";
  return "unknown";
}

export function whereLine(label: string, ip?: string, org?: string, kind?: Where["kind"]): string {
  const at = ip ? ` It is seen from ${ip}${org ? ` (${org})` : ""}.` : "";
  if (kind === "datacenter") return `This browser runs on a server, from a data-centre address.${at} That is the view BeeZilla's AI gets, not your home connection.`;
  if (kind === "home") return `Heads up: this browser's address looks like a home or office connection, not a server.${at} The AI may see pages differently.`;
  if (ip) return `This browser runs on a server.${at}`;
  return `${label}. Checking the address it goes out from…`;
}

/** Ask a browser what address it goes out from, then what kind of address that is. */
async function checkWhere(ask: (expr: string) => Promise<unknown>, label: string): Promise<Where> {
  let ip = "";
  for (const url of ["https://api.ipify.org?format=json", "https://api64.ipify.org?format=json"]) {
    try {
      const got = await ask(`(async function () { var r = await fetch(${JSON.stringify(url)}, { cache: "no-store" }); var j = await r.json(); return String(j.ip || ""); })()`);
      if (typeof got === "string" && /^[0-9a-fA-F:.]{3,45}$/.test(got)) { ip = got; break; }
    } catch { /* try the next one */ }
  }
  if (!ip) return { label, line: `${label}. Its address could not be checked.` };
  let org = "";
  try {
    const r = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) org = tidy(((await r.json()) as { org?: string }).org ?? "", 100).replace(/^AS\d+\s+/, "");
  } catch { /* the address alone is still useful */ }
  const kind = org ? classifyOrg(org) : "unknown";
  return { label, ip, org: org || undefined, kind, line: whereLine(label, ip, org, kind) };
}

// ── Addresses the server browser must not open ────────────────────────────
//
// The browser runs somewhere else, but "somewhere else" can have an inside: a cloud's
// metadata address, a container's own services, a private network. Whatever opens a page
// here — the address bar, a played step, a link that opens a window, and every link and
// redirect the page itself follows (the Fetch interception in begin()) — is checked first.
// BZ_BROWSER_ALLOW_PRIVATE=1 lifts it for a browser run on your own machine for tests.

const allowPrivate = () => env("BZ_BROWSER_ALLOW_PRIVATE") === "1";

/** An address that is itself this machine, a private network or an internal name. */
export function privateTarget(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;   // about:blank, data: … reach no network
  // "localhost." (a dot on the end) is the same name, and the browser sends it to this machine too.
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".home.arpa")) return true;
  if (isIP(host)) return isPrivateIp(host);
  // A name with no dot ("grafana", "router") is never a public one: the browser would find it on
  // the machine's own network, through the search domains and the hosts file this server can't see.
  return !host.includes(".");
}
const resolver = new dnsPromises.Resolver({ timeout: 3000, tries: 1 });
const nameSeen = new Map<string, { bad: boolean; at: number }>();
/**
 * Does this name answer with a private address — or with nothing at all here? A public name always
 * answers; one that doesn't may be one only the browser's own network knows (the hosts file, a
 * search domain), so it is not opened. (A name that answers publicly now and privately a moment
 * later — DNS rebinding — cannot be told apart from here: run the browser on a network with no
 * inside, or set BZ_BROWSER_PROXY to an egress proxy that refuses private ranges.)
 */
async function namePointsInside(host: string): Promise<boolean> {
  const hit = nameSeen.get(host);
  if (hit && Date.now() - hit.at < 15_000) return hit.bad;
  let bad = true;
  try {
    const [a, b] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    const all = [...(a.status === "fulfilled" ? a.value : []), ...(b.status === "fulfilled" ? b.value : [])];
    bad = all.length === 0 || all.some((x) => isPrivateIp(x));
  } catch { bad = true; }
  if (nameSeen.size > 500) nameSeen.clear();
  nameSeen.set(host, { bad, at: Date.now() });
  return bad;
}
async function mustRefuse(url: string): Promise<boolean> {
  if (allowPrivate()) return false;
  if (privateTarget(url)) return true;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || isIP(u.hostname.replace(/^\[|\]$/g, ""))) return false;
  return namePointsInside(u.hostname.replace(/\.+$/, "").toLowerCase());
}

// ── The page-side helpers ──────────────────────────────────────────────────
//
// Run inside the page through Runtime.evaluate and answer with plain data. They are
// written as one string (no template literals inside) so a bundler cannot rewrite them.

const PAGE_LIB = String.raw`(function () {
  // A box for a secret: a password, a code sent to the person, a card or bank number. ("Zip code",
  // "promo code" and the like are not secrets.)
  var SECRET = /pass(word|code|wort)?|pwd|contrase|mot.?de.?passe|senha|secret|token|otp|totp|one.?time|2fa|mfa|verification|security.?code|\bpin\b|cvv|cvc|card.?(number|no|num)|cc.?(num|csc|exp)|ssn|social.?sec|iban|account.?(no|num)|routing|(?<!zip |postal |post |promo |coupon |discount |referral |area |country |gift |voucher |product |item |colou?r |style |source |dress |embed |qr )\bcode\b|\bcard\b/i;
  var watch = { el: null, moved: false };
  document.addEventListener("focusin", function (e) { if (watch.el && e.target !== watch.el) watch.moved = true; }, true);
  var CAND = "a,button,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[onclick],[tabindex]";
  function txt(s, n) { s = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
  function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9À-￿]+/g, " ").trim(); }
  function vis(e) {
    var r = e.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var cs = getComputedStyle(e);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) !== 0;
  }
  function interactive(e) {
    if (!e || e.nodeType !== 1) return false;
    var t = e.tagName.toLowerCase();
    if (/^(a|button|input|select|textarea|summary|label|option)$/.test(t)) return true;
    var r = e.getAttribute("role");
    if (r && /^(button|link|tab|menuitem|checkbox|radio|switch|option|combobox|textbox|searchbox|treeitem)$/.test(r)) return true;
    if (e.isContentEditable || e.hasAttribute("onclick")) return true;
    try { return getComputedStyle(e).cursor === "pointer"; } catch (_) { return false; }
  }
  function nameOf(e) {
    var n = e.getAttribute("aria-label");
    if (n && txt(n, 90)) return txt(n, 90);
    var by = e.getAttribute("aria-labelledby");
    if (by) {
      var p = by.split(/\s+/).map(function (id) { var o = document.getElementById(id); return o ? o.textContent : ""; }).join(" ");
      if (txt(p, 90)) return txt(p, 90);
    }
    if (e.labels && e.labels.length) { var l = txt(e.labels[0].textContent, 90); if (l) return l; }
    var t = e.tagName.toLowerCase();
    if (t === "input" && /^(button|submit|reset)$/.test(e.type)) return txt(e.value, 90);
    if (t === "img") return txt(e.alt, 90);
    var inner = txt(e.innerText || e.textContent, 90);
    if (inner) return inner;
    // A button that is only a picture or an icon: the picture's own words ("Buy", "Download").
    var sub = e.querySelector ? e.querySelector("img[alt],svg title,[aria-label],[title]") : null;
    if (sub) {
      var st = sub.tagName.toLowerCase();
      var sn = st === "img" ? sub.alt : st === "title" ? sub.textContent : (sub.getAttribute("aria-label") || sub.getAttribute("title"));
      if (txt(sn, 90)) return txt(sn, 90);
    }
    return txt(e.getAttribute("title") || e.getAttribute("placeholder") || e.getAttribute("alt") || e.getAttribute("name") || "", 90);
  }
  function esc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&"); }
  function one(s) { try { return document.querySelectorAll(s).length === 1; } catch (_) { return false; } }
  function sel(e) {
    var tag = e.tagName.toLowerCase(), v, s;
    if (e.id && !/\d{4,}|^[0-9a-f-]{16,}$/i.test(e.id)) { s = "#" + esc(e.id); if (one(s)) return s; }
    v = e.getAttribute("data-testid") || e.getAttribute("data-test") || e.getAttribute("data-qa");
    if (v) { s = "[data-testid=\"" + v.replace(/"/g, "") + "\"]"; if (one(s)) return s; }
    v = e.getAttribute("name");
    if (v) { s = tag + "[name=\"" + v.replace(/"/g, "") + "\"]"; if (one(s)) return s; }
    v = e.getAttribute("aria-label");
    if (v) { s = tag + "[aria-label=\"" + v.replace(/"/g, "") + "\"]"; if (one(s)) return s; }
    v = tag === "a" ? e.getAttribute("href") : "";
    if (v && v.length < 200) { s = "a[href=\"" + v.replace(/"/g, "") + "\"]"; if (one(s)) return s; }
    var parts = [], cur = e, depth = 0;
    while (cur && cur.nodeType === 1 && depth < 5) {
      var t = cur.tagName.toLowerCase();
      if (cur.id && !/\d{4,}/.test(cur.id)) { parts.unshift("#" + esc(cur.id)); break; }
      var idx = 1, sib = cur;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === cur.tagName) idx++;
      parts.unshift(t + ":nth-of-type(" + idx + ")");
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(" > ").slice(0, 240);
  }
  function describe(e) {
    var tag = e.tagName.toLowerCase();
    var type = tag === "input" ? String(e.type || "text").toLowerCase() : "";
    var name = nameOf(e);
    var ph = txt(e.getAttribute("placeholder"), 90);
    var ac = String(e.getAttribute("autocomplete") || "").toLowerCase();
    var editable = tag === "textarea" || (tag === "input" && !/^(button|submit|reset|checkbox|radio|file|image|range|color)$/.test(type)) || !!e.isContentEditable;
    var secret = type === "password" || /one-time-code|cc-|current-password|new-password/.test(ac) || (editable && SECRET.test([name, e.id, e.getAttribute("name") || "", ph].join(" ")));
    var r = e.getBoundingClientRect();
    return {
      tag: tag, role: txt(e.getAttribute("role"), 30), name: name, type: type, placeholder: ph,
      href: tag === "a" ? txt(e.getAttribute("href"), 300) : "", sel: sel(e),
      ac: ac.slice(0, 40), secret: secret, editable: editable, choice: tag === "select",
      x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)
    };
  }
  function describeAt(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el) return null;
    var t = el, i = 0;
    while (t && i < 7 && !interactive(t)) { t = t.parentElement; i++; }
    var hit = t && interactive(t) ? t : el;
    var d = describe(hit);
    // Nothing clickable here: a click on plain page. Name it only when it is a short piece of
    // text of its own, never "the whole page" (a body's words are every word on it).
    if (!interactive(hit)) {
      var own = txt(hit.innerText || hit.textContent, 200);
      if (hit === document.body || hit === document.documentElement || own.length > 70) { d.name = ""; d.sel = ""; }
    }
    return d;
  }
  // The box typing is going into, asked about on the first key and remembered: if the cursor
  // moves on by itself (a card's expiry that jumps to its security code) before the text is
  // written down, that text is never recorded, since it may belong to a secret box.
  function arm() {
    var e = document.activeElement;
    if (!e || e === document.body || e === document.documentElement) { watch.el = null; return null; }
    watch.el = e;
    watch.moved = false;
    return describe(e);
  }
  function value() {
    var e = watch.el;
    if (!e) return null;
    if (watch.moved || document.activeElement !== e) return { moved: true };
    if (describe(e).secret) return { secret: true };
    if ("value" in e) return { v: String(e.value == null ? "" : e.value).slice(0, 800) };
    if (e.isContentEditable) return { v: String(e.innerText || "").slice(0, 800) };
    return null;
  }
  function ready() { return String(document.readyState); }
  function options(x, y) {
    var el = document.elementFromPoint(x, y);
    while (el && el.tagName !== "SELECT") el = el.parentElement;
    if (!el) return null;
    var out = [];
    for (var i = 0; i < el.options.length && i < 60; i++) out.push({ i: i, text: txt(el.options[i].text, 80), selected: el.options[i].selected });
    return { options: out, name: nameOf(el), sel: sel(el) };
  }
  function find(on, px, py) {
    var el = null, how = "";
    if (on && on.sel) { try { var c = document.querySelector(on.sel); if (c && vis(c)) { el = c; how = "sel"; } } catch (_) {} }
    if (!el && on && on.name) {
      var want = norm(on.name), best = null, bs = 0, all = document.querySelectorAll(CAND);
      for (var i = 0; i < all.length && i < 3000; i++) {
        var e = all[i];
        if (!vis(e)) continue;
        var n = norm(nameOf(e));
        if (!n) continue;
        var s = 0;
        if (n === want) s = 3;
        else if ((n.indexOf(want) === 0 || want.indexOf(n) === 0) && Math.min(n.length, want.length) / Math.max(n.length, want.length) >= 0.6) s = 2;
        else if ((n.indexOf(want) >= 0 || want.indexOf(n) >= 0) && Math.min(n.length, want.length) / Math.max(n.length, want.length) >= 0.75) s = 1;
        else continue;
        if (on.tag && e.tagName.toLowerCase() === on.tag) s += 0.5;
        if (on.type && String(e.type || "") === on.type) s += 0.25;
        if (s > bs) { bs = s; best = e; }
      }
      if (best) { el = best; how = "name"; }
    }
    if (!el && typeof px === "number") { el = document.elementFromPoint(px, py); how = "point"; }
    if (!el) return null;
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (_) {}
    var r = el.getBoundingClientRect();
    var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    return { x: cx, y: cy, how: how, name: nameOf(el), editable: describe(el).editable, at: atPoint(cx, cy),
      disabled: !!(el.disabled || (el.getAttribute && el.getAttribute("aria-disabled") === "true")) };
  }
  function pick(x, y, idx) {
    var el = document.elementFromPoint(x, y);
    while (el && el.tagName !== "SELECT") el = el.parentElement;
    if (!el || !el.options[idx]) return null;
    el.selectedIndex = idx;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { text: txt(el.options[idx].text, 80), name: nameOf(el) };
  }
  function setSelect(on, text) {
    var el = null;
    if (on && on.sel) { try { el = document.querySelector(on.sel); } catch (_) {} }
    if (!el || el.tagName !== "SELECT") return false;
    for (var i = 0; i < el.options.length; i++) {
      if (norm(el.options[i].text) === norm(text)) {
        el.selectedIndex = i;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    return false;
  }
  function selectActive() { var e = document.activeElement; if (e && typeof e.select === "function") { try { e.select(); } catch (_) {} } return true; }
  function look() { return { url: String(location.href), title: txt(document.title, 140) }; }
  function nav() { var n = window.navigation; return { api: !!n, back: !!(n && n.canGoBack), fwd: !!(n && n.canGoForward) }; }
  function go(n) { history.go(n); return true; }
  function readText() { return txt(document.body ? document.body.innerText : "", 700); }

  // ── For BeeZilla doing a job itself: the page as a numbered list of things to act on ──
  var marks = [];
  var CONTROL = "a,button,summary,select,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[role=checkbox],[role=radio],[role=switch]";
  function deep(root, out, depth) {
    var list;
    try { list = root.querySelectorAll(CAND + ",[role=textbox],[role=searchbox],[role=slider],[role=spinbutton],[contenteditable=''],[contenteditable=true]"); } catch (_) { return; }
    for (var i = 0; i < list.length && out.length < 4000; i++) out.push(list[i]);
    // A page built from parts that are clicked without saying so (a box with a pointer cursor).
    var loose = root.querySelectorAll("div,span,li,img,svg,i,p,td");
    for (var j = 0, n = 0; j < loose.length && j < 15000 && n < 4000; j++) {
      var e = loose[j];
      if (e.closest && e.closest(CONTROL)) continue;
      var cs;
      try { cs = getComputedStyle(e); } catch (_) { continue; }
      if (cs.cursor !== "pointer") continue;
      var p = e.parentElement;
      try { if (p && getComputedStyle(p).cursor === "pointer") continue; } catch (_) {}
      out.push(e); n++;
    }
    if (depth > 2) return;
    var all = root.querySelectorAll("*");
    for (var k = 0; k < all.length && k < 20000; k++) if (all[k].shadowRoot) deep(all[k].shadowRoot, out, depth + 1);
  }
  function snapshot(max) {
    max = max || 90;
    var vw = window.innerWidth, vh = window.innerHeight;
    var found = [];
    deep(document, found, 0);
    var seen = new Set(), items = [];
    for (var i = 0; i < found.length; i++) {
      var e = found[i];
      if (seen.has(e)) continue;
      seen.add(e);
      var tag = e.tagName.toLowerCase();
      if (tag === "label" || tag === "option") continue;
      var field = /^(input|textarea|select)$/.test(tag) || e.isContentEditable;
      // The words or picture inside a button are the button.
      if (!field && e.parentElement && e.parentElement.closest && e.parentElement.closest(CONTROL)) continue;
      if (tag === "input" && String(e.type).toLowerCase() === "hidden") continue;
      if (!vis(e) && !(tag === "input" && String(e.type).toLowerCase() === "file")) continue;
      if (!field && !interactive(e)) continue;
      var r = e.getBoundingClientRect();
      items.push({ e: e, top: r.top + window.scrollY, left: r.left + window.scrollX, inView: r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw });
    }
    items.sort(function (a, b) { return (a.inView === b.inView ? 0 : a.inView ? -1 : 1) || (a.top - b.top) || (a.left - b.left); });
    items = items.slice(0, max);
    items.sort(function (a, b) { return (a.top - b.top) || (a.left - b.left); });
    marks = [];
    var els = [];
    for (var k = 0; k < items.length; k++) {
      var el = items[k].e;
      marks.push(el);
      var d = describe(el);
      var o = { i: k, tag: d.tag, role: d.role, name: d.name, type: d.type, ph: d.placeholder, inView: items[k].inView };
      if (d.secret) o.secret = true;
      if (d.editable) {
        o.editable = true;
        if (!d.secret) { var v = "value" in el ? String(el.value == null ? "" : el.value) : el.isContentEditable ? String(el.innerText || "") : ""; if (v) o.value = txt(v, 80); }
      }
      if (d.tag === "a" && d.href) o.href = txt(d.href, 100);
      if (el.disabled || el.getAttribute("aria-disabled") === "true") o.disabled = true;
      var role = el.getAttribute("role");
      if (d.type === "checkbox" || d.type === "radio" || role === "checkbox" || role === "switch" || role === "radio") o.checked = !!(el.checked || el.getAttribute("aria-checked") === "true");
      if (d.tag === "select") {
        o.options = [];
        for (var q = 0; q < el.options.length && q < 15; q++) o.options.push(txt(el.options[q].text, 40));
        o.value = el.selectedIndex >= 0 && el.options[el.selectedIndex] ? txt(el.options[el.selectedIndex].text, 40) : "";
      }
      if (d.tag === "input" && d.type === "file") o.file = true;
      if (el.getAttribute("aria-expanded")) o.expanded = el.getAttribute("aria-expanded") === "true";
      els.push(o);
    }
    var main = document.querySelector("main,[role=main]");
    var words = main && main.innerText && main.innerText.length > 200 ? main.innerText : (document.body ? document.body.innerText : "");
    var se = document.scrollingElement || document.documentElement;
    return { els: els, text: txt(words, 3000), below: Math.max(0, Math.round(se.scrollHeight - window.scrollY - vh)), above: Math.round(window.scrollY), total: found.length };
  }
  function markAt(i) {
    var e = marks[i];
    if (!e || !e.isConnected) return null;
    try { e.scrollIntoView({ block: "center", inline: "center" }); } catch (_) {}
    var d = describe(e);
    var r = e.getBoundingClientRect();
    var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    var hit = document.elementFromPoint(x, y);
    d.covered = !!(hit && hit !== e && !e.contains(hit) && !hit.contains(e));
    if (d.covered) {
      // A pop-up in front (a dialog, a banner) is the person's or the job's to deal with first; a
      // layer the page lays over its own button (no name, not a dialog) is clicked through.
      var box = hit.closest ? hit.closest("[role=dialog],[role=alertdialog],[aria-modal=true],dialog,[id*=cookie i],[class*=cookie i],[id*=consent i],[class*=consent i],[class*=modal i],[class*=popup i],[class*=banner i]") : null;
      d.coveredBy = box ? txt(nameOf(box) || box.getAttribute("aria-label") || "", 60) || "a pop-up" : "";
      d.overlay = !box;
      // What a click at that point would really press.
      d.hitName = atPoint(x, y);
    }
    d.x = x; d.y = y;
    d.disabled = !!(e.disabled || e.getAttribute("aria-disabled") === "true");
    d.file = e.tagName === "INPUT" && String(e.type).toLowerCase() === "file";
    d.hidden = r.width < 2 || r.height < 2;
    return d;
  }
  /** The name of the thing a click at (x, y) would press (the nearest clickable thing there). */
  function atPoint(x, y) {
    var t = document.elementFromPoint(x, y), k = 0;
    while (t && k < 7 && !interactive(t)) { t = t.parentElement; k++; }
    return t && interactive(t) ? nameOf(t) : "";
  }
  /** What Enter or Space would press now: the thing with the cursor, and a form's own send button. */
  function wouldPress() {
    var a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    if (!a || a === document.body || a === document.documentElement) return [];
    var out = [nameOf(a)];
    var f = a.form || (a.closest ? a.closest("form") : null);
    if (f) {
      var b = f.querySelector("button:not([type=button]):not([type=reset]),input[type=submit],input[type=image]");
      if (b) out.push(nameOf(b));
      out.push(txt(f.getAttribute("aria-label") || f.getAttribute("name") || "", 60));
    }
    return out.filter(function (x) { return !!x; });
  }
  /** Is the cursor in thing i (and what kind of box is it)? A page can move it somewhere else. */
  function focusIs(i) {
    var e = marks[i], a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    if (!e || !a || a === document.body) return { ok: false };
    var d = describe(a);
    return { ok: a === e || e.contains(a) || a.contains(e), secret: !!d.secret, editable: !!d.editable, name: d.name };
  }
  function activeSecret() {
    var a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return !!(a && a !== document.body && a !== document.documentElement && describe(a).secret);
  }
  function focusMark(i) { var e = marks[i]; if (!e || !e.isConnected) return false; try { e.focus(); } catch (_) { return false; } return true; }
  function pressAt(i) {
    var e = marks[i];
    if (!e || !e.isConnected) return false;
    try { if (e.focus) e.focus(); } catch (_) {}
    e.click();
    return true;
  }
  function chooseAt(i, text) {
    var e = marks[i];
    if (!e || e.tagName !== "SELECT") return null;
    var want = norm(text), best = -1;
    for (var k = 0; k < e.options.length; k++) {
      var n = norm(e.options[k].text);
      if (n === want) { best = k; break; }
      if (best < 0 && want && n.indexOf(want) >= 0) best = k;
    }
    if (best < 0) return null;
    e.selectedIndex = best;
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
    return { text: txt(e.options[best].text, 80), name: nameOf(e), sel: sel(e) };
  }
  // A file handed to the page, put in a file box (or dropped on a drop zone) the way a person's
  // own file would be. It comes in parts: a whole song is bigger than one message.
  var parts = {};
  function filePart(id, chunk, first) { if (first || !parts[id]) parts[id] = []; parts[id].push(chunk); return parts[id].length; }
  function giveFile(i, id, name, type) {
    var e = marks[i];
    var b64 = (parts[id] || []).join("");
    delete parts[id];
    if (!e || !e.isConnected || !b64) return { ok: false };
    var bin = atob(b64), u = new Uint8Array(bin.length);
    for (var k = 0; k < bin.length; k++) u[k] = bin.charCodeAt(k);
    var file = new File([u], name, { type: type || "application/octet-stream" });
    var dt = new DataTransfer();
    dt.items.add(file);
    var form = e.closest ? e.closest("form") : null;
    var input = e.tagName === "INPUT" && String(e.type).toLowerCase() === "file" ? e : (e.querySelector && e.querySelector("input[type=file]")) || (form && form.querySelector("input[type=file]"));
    if (input) {
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, how: "box" };
    }
    ["dragenter", "dragover", "drop"].forEach(function (t) {
      try { e.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt })); } catch (_) {}
    });
    return { ok: true, how: "drop" };
  }
  // A download the page made itself (a blob: address): read in parts for the same reason.
  var blobs = {};
  function grabBlob(id, url) {
    return fetch(url).then(function (r) { return r.blob(); }).then(function (b) {
      return new Promise(function (res) {
        var fr = new FileReader();
        fr.onload = function () { var s = String(fr.result || ""); blobs[id] = s.slice(s.indexOf(",") + 1); res({ ok: true, type: b.type || "", size: b.size, len: blobs[id].length }); };
        fr.onerror = function () { res({ ok: false }); };
        fr.readAsDataURL(b);
      });
    }).catch(function () { return { ok: false }; });
  }
  function blobPart(id, start, len) { var s = blobs[id] || ""; var out = s.slice(start, start + len); if (start + len >= s.length) delete blobs[id]; return out; }
  function still() { return String(document.readyState) === "complete"; }
  return { describeAt: describeAt, arm: arm, value: value, options: options, find: find, pick: pick, setSelect: setSelect, selectActive: selectActive, look: look, readText: readText, ready: ready, nav: nav, go: go,
    snapshot: snapshot, markAt: markAt, pressAt: pressAt, chooseAt: chooseAt, wouldPress: wouldPress, focusIs: focusIs, focusMark: focusMark, atPoint: atPoint, activeSecret: activeSecret, filePart: filePart, giveFile: giveFile, grabBlob: grabBlob, blobPart: blobPart, still: still };
})()`;

/**
 * In the page's own world, before its scripts run: a download the page builds itself (a blob:
 * address) is let go a couple of minutes later than the page asks, so it can still be read
 * after the page has handed it over. Nothing else about the page changes.
 */
const KEEP_BLOBS = "(function(){try{var r=URL.revokeObjectURL;if(!r||r.__bz)return;var k=function(u){setTimeout(function(){try{r.call(URL,u)}catch(e){}},150000)};k.__bz=1;URL.revokeObjectURL=k;}catch(e){}})()";

/** A call into the helpers, as the text to run. They live in a world of their own (see page()). */
const call = (fn: string, ...args: unknown[]) => `globalThis.__bz.${fn}(${args.map((a) => (a === undefined ? "undefined" : JSON.stringify(a))).join(",")})`;

// ── Words for a step ───────────────────────────────────────────────────────

interface Seen {
  tag?: string; role?: string; name?: string; type?: string; placeholder?: string; href?: string; sel?: string; ac?: string;
  secret?: boolean; editable?: boolean; choice?: boolean; x?: number; y?: number;
}

const hintOf = (d: Seen | null | undefined): ElementHint | undefined => {
  if (!d) return undefined;
  return { tag: d.tag, role: d.role || undefined, name: d.name || undefined, sel: d.sel || undefined, type: d.type || undefined, placeholder: d.placeholder || undefined, href: d.href || undefined, ac: d.ac || undefined };
};
const called = (d: Seen | null | undefined): string => {
  const n = plain(d?.name || d?.placeholder || "", 60);
  return n ? `“${n}”` : "";
};
export function wordsForClick(d: Seen | null | undefined): string {
  if (!d) return "Click on the page";
  const n = called(d);
  if (d.tag === "a") return n ? `Click the link ${n}` : "Click a link";
  if (d.type === "checkbox" || d.type === "radio") return n ? `Tick or untick ${n}` : "Tick or untick a box";
  if (d.editable) return n ? `Click into ${n}` : "Click into a text box";
  if (d.tag === "button" || d.role === "button" || d.type === "submit" || d.type === "button") return n ? `Click the button ${n}` : "Click a button";
  if (d.tag === "select" || d.role === "combobox") return n ? `Open the list ${n}` : "Open a list";
  return n ? `Click ${n}` : "Click on the page";
}
export function wordsForType(d: Seen | null | undefined): string {
  const n = called(d);
  if (d?.secret) return n ? `Type your own password or code into ${n} (not recorded)` : "Type your own password or code (not recorded)";
  return n ? `Type into ${n}` : "Type into the text box";
}
const hostPath = (u: string): string => {
  try { const x = new URL(u); return x.host + (x.pathname === "/" ? "" : x.pathname); } catch { return u; }
};
export const wordsForGoto = (u: string) => `Go to ${tidy(hostPath(u), 90)}`;

/** A blank's words, by its name however it was written ("song idea" fills "Song idea"). */
export function fillFor(fill: Record<string, string>, blank: string | undefined): string | undefined {
  if (!blank) return undefined;
  if (typeof fill[blank] === "string") return fill[blank];
  const key = (x: string) => x.toLowerCase().replace(/[^a-z0-9\u00c0-\uffff]+/g, " ").trim();
  const want = key(blank);
  for (const [k, v] of Object.entries(fill)) if (key(k) === want) return v;
  return undefined;
}

/**
 * Is this address on one of these sites? A site is its host without "www." and, for a deeper name,
 * the last two parts (three when the second-to-last is short, as in example.co.uk).
 */
export function siteOf(u: string): string {
  let host = "";
  try { host = new URL(u).hostname.toLowerCase().replace(/\.+$/, ""); } catch { return ""; }
  if (!host || isIP(host.replace(/^\[|\]$/g, ""))) return host;
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const keep = parts[parts.length - 2]!.length <= 3 && parts.length >= 3 ? 3 : 2;
  return parts.slice(-keep).join(".");
}
export function siteAllowed(url: string, allowed: string[]): boolean {
  const want = siteOf(url);
  if (!want) return false;
  return allowed.some((a) => {
    const s = siteOf(/^[a-z][a-z0-9+.-]*:/i.test(a) ? a : "https://" + a);
    return !!s && s === want;
  });
}
/** The sites a job's own words name ("go to mureka.ai/create…"), as addresses. */
export function sitesIn(...texts: Array<string | undefined>): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    for (const m of String(t ?? "").matchAll(/(?:https?:\/\/[^\s"'<>]+|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b)/gi)) {
      const raw = m[0].replace(/[.,;:!?)]+$/, "");
      const s = siteOf(/^https?:/i.test(raw) ? raw : "https://" + raw);
      if (s && s.includes(".")) out.add(s);
    }
  }
  return [...out];
}

/** The words for a recording's blanks: names to text, capped. */
export function cleanFill(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 20)) {
    const name = plain(k, 40);
    if (name && (typeof x === "string" || typeof x === "number")) out[name] = String(x).slice(0, 4000);
  }
  return out;
}
/**
 * A box BeeZilla typed the words of the moment into (the song idea it was handed) becomes a
 * blank when the job is kept as a recording: next time it is filled with that day's words.
 */
function blankFor(text: string, details: string | undefined, d: Seen): string | undefined {
  const t = text.trim();
  const g = String(details ?? "").trim();
  if (t.length < 8 || g.length < 8) return undefined;
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ");
  if (!norm(g).includes(norm(t).slice(0, 200)) && !norm(t).includes(norm(g).slice(0, 200))) return undefined;
  return plain(d.name || d.placeholder || "The words", 40) || "The words";
}

// ── A session ──────────────────────────────────────────────────────────────

export type SessionEvent =
  | { type: "hello"; id: string; view: { w: number; h: number }; recording: boolean; steps: BrowserStep[]; url: string; title: string; where: Where | null; replaying: boolean; canBack: boolean; canForward: boolean; maxSeconds: number; idleSeconds: number; label: string;
      run: { kind: BrowserMode; by: RunBy; task?: string; nodeId?: string; acts: { i: number; say: string; state: string; note?: string }[] } | null; files: RunFile[]; signIns: boolean }
  | { type: "frame"; seq: number; w: number; h: number; b64: string }
  | { type: "nav"; url: string; title: string; canBack: boolean; canForward: boolean }
  | { type: "step"; i: number; step: BrowserStep }
  | { type: "steps"; steps: BrowserStep[] }
  | { type: "rec"; on: boolean }
  | { type: "where"; where: Where }
  | { type: "pick"; options: { i: number; text: string; selected: boolean }[]; name: string; x: number; y: number }
  | { type: "replay"; i: number; state: "running" | "ok" | "skipped" | "failed"; note?: string }
  | { type: "replay-done"; ok: boolean; failedAt?: number; note: string; steps: number; finalUrl: string; title: string; text: string }
  | { type: "notice"; text: string }
  | { type: "ended"; reason: string }
  | { type: "run"; state: "start"; kind: BrowserMode; by: RunBy; task?: string; nodeId?: string }
  | { type: "run"; state: "end"; result: RunResult }
  | { type: "act"; i: number; say: string; state: "running" | "ok" | "failed"; note?: string }
  | { type: "file"; state: "started" | "saved" | "failed"; name: string; url?: string; bytes?: number; fileType?: string; note?: string };

export type RunBy = "you" | "beezilla";
/** How a run of a node ended: what BeeZilla is told, and what the card keeps. */
export interface RunResult {
  ok: boolean;
  kind: BrowserMode;
  by: RunBy;
  /** One plain sentence. */
  note: string;
  /** It stopped because the person has to do something: what, in words. */
  needs?: string;
  /** The person pressed Stop. */
  stopped?: boolean;
  /** A recording: the step it could not do. */
  failedAt?: number;
  /** How many steps were done. */
  ran: number;
  files: RunFile[];
  finalUrl: string;
  title: string;
  /** The page's own words at the end: data, never instructions. */
  text: string;
  /** A task: what BeeZilla did, as steps that can be kept as the node's recording. */
  steps?: BrowserStep[];
  seconds: number;
  /** The node it was (a window showing another node leaves this result alone). */
  nodeId?: string;
}

/** One thing BeeZilla does on a page while doing a job itself (browserAgent.ts decides which). */
export type AgentAction =
  | { do: "click"; el: number }
  | { do: "type"; el: number; text: string; enter?: boolean }
  | { do: "press"; key: string }
  | { do: "select"; el: number; option: string }
  | { do: "scroll"; dir: "down" | "up" }
  | { do: "goto"; url: string }
  | { do: "back" }
  | { do: "wait"; seconds: number }
  | { do: "upload"; el: number; file: string };
export interface ActOutcome {
  ok: boolean;
  /** What happened, in a few plain words (for the model and the window). */
  note: string;
  /** The person must do this one: what, in words. The job stops. */
  needs?: string;
  step?: BrowserStep;
}
/** The page as BeeZilla sees it while doing a job: numbered things to act on, and its words. */
export interface PageView {
  url: string;
  title: string;
  els: Array<{
    i: number; tag: string; role?: string; name?: string; type?: string; ph?: string; value?: string; href?: string;
    inView?: boolean; secret?: boolean; editable?: boolean; disabled?: boolean; checked?: boolean; options?: string[]; file?: boolean; expanded?: boolean;
  }>;
  text: string;
  below: number;
  above: number;
  files: RunFile[];
  downloading: number;
}

/**
 * Buttons BeeZilla never presses on its own, in a recording or a job: money and the account
 * itself. Paying, buying, subscribing, a trial that turns into a charge, deleting or closing an
 * account are the person's to press (docs/TOOL-AND-BROWSER-PLAN.md D4). The job stops there and
 * says so; the person can press it themselves in the window.
 */
export const MONEY_WORDS = /\b(?:pay|payment|paying|buy|buying|purchase|checkout|check out|place (?:my |your |the )?order|order now|subscribe|subscription|upgrade|start (?:my |your |a |the )?(?:free )?trial|add (?:a )?(?:card|payment(?: method)?)|billing|donate|top ?up|add funds|confirm (?:and pay|purchase|payment)|complete (?:purchase|payment|order)|book now|reserve now|go premium|get (?:pro|premium|plus))\b/i;
export const ACCOUNT_WORDS = /\b(?:delete (?:my |your |the )?account|close (?:my |your |the )?account|deactivate|cancel (?:my |your |the )?(?:subscription|plan|membership))\b/i;
/**
 * The other doors: a press that puts the person's words out in the world where they cannot be
 * taken back — a post, a publish, a send, a submit. Same rule as money and the account: the
 * person presses it (docs/TOOL-AND-BROWSER-PLAN.md D4). This is one line on purpose: if the
 * owner decides his own "post it" is the approval, this arm is what he lifts.
 */
export const DOOR_WORDS = /\b(?:post|publish|send|submit)\b/i;
export function personOnly(name: string | undefined): string | null {
  const n = plain(name ?? "", 60);
  if (!n) return null;
  if (MONEY_WORDS.test(n)) return `BeeZilla stopped before pressing “${n}”: paying, buying and subscribing are yours to press. Press it yourself in BeeZilla's browser if you mean to.`;
  if (ACCOUNT_WORDS.test(n)) return `BeeZilla stopped before pressing “${n}”: that changes your account, so it is yours to press.`;
  if (DOOR_WORDS.test(n)) return `BeeZilla stopped before pressing “${n}”: posting, publishing and sending put your words out where they can't be taken back, so that press is yours. Press it yourself in BeeZilla's browser if you mean to.`;
  return null;
}
/** Keys a job or a played step may press. */
const JOB_KEYS = new Set(["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "PageDown", "PageUp", "Home", "End", "Backspace", " "]);
export const isJobKey = (k: string) => JOB_KEYS.has(k);

export type InputEvent =
  | { type: "mouse"; action: "down" | "up" | "move"; x: number; y: number; button?: "left" | "middle" | "right"; buttons?: number; clickCount?: number; mods?: number }
  | { type: "wheel"; x: number; y: number; dx?: number; dy: number; mods?: number }
  | { type: "key"; action: "down" | "up"; key: string; code?: string; text?: string; mods?: number; keyCode?: number; commands?: string[] }
  | { type: "text"; text: string }
  | { type: "choose"; x: number; y: number; index: number };

const KEYCODES: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27, " ": 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46,
};
const keyCodeFor = (key: string): number => {
  if (KEYCODES[key] !== undefined) return KEYCODES[key]!;
  if (key.length === 1) {
    const up = key.toUpperCase();
    if (/[A-Z0-9]/.test(up)) return up.charCodeAt(0);
  }
  return 0;
};
// Select-all and undo/redo only; the keyboard shortcuts for copy, cut and paste are dropped too
// (in one()), because the browser's clipboard is shared by everyone on a shared browser.
const EDIT_COMMANDS = new Set(["selectAll", "undo", "redo"]);

type Listener = (ev: SessionEvent) => void;

export class BrowserSession {
  readonly id = randomBytes(16).toString("hex");
  readonly startedAt = Date.now();
  lastInput = Date.now();
  steps: BrowserStep[] = [];
  recording = false;
  replaying = false;
  where: Where | null = null;
  url = "about:blank";
  title = "";
  canBack = false;
  canForward = false;
  closed = false;
  /** How long this one may stay open: the session limit, or what the person has left of today's time. */
  maxMs = sessionSeconds() * 1000;
  /** Set by the route: told every minute (and at the end) how many seconds to count against the plan. */
  onBill?: (seconds: number) => void;
  /** Set by the route: told once, with the seconds the browser was open. */
  onClosed?: (info: { seconds: number; reason: string }) => void;

  private listeners = new Map<Listener, (() => void) | undefined>();
  private frame: { seq: number; w: number; h: number; b64: string } | null = null;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private frameSent = 0;
  private seq = 0;
  private lastStepAt = 0;
  private downAt: { x: number; y: number; seen: Seen | null } | null = null;
  private typing: { seen: Seen; at: number } | null = null;
  private typingTimer: ReturnType<typeof setTimeout> | null = null;
  private scrolled: { dy: number } | null = null;
  private scrollTimer: ReturnType<typeof setTimeout> | null = null;
  private navTimer: ReturnType<typeof setTimeout> | null = null;
  private opChain: Promise<unknown> = Promise.resolve();
  private targetId = "";
  private contextId = "";
  private sid: string | undefined;
  private world: number | null = null;
  private pending = 0;
  private popups = 0;
  private billedAt = Date.now();
  private stopHandlers: (() => void)[] = [];
  /** A job or a played recording going on now (one at a time). */
  run: { kind: BrowserMode; by: RunBy; task?: string; nodeId?: string; stop: boolean; started: number; firstFile: number; acts: { i: number; say: string; state: string; note?: string }[] } | null = null;
  /** The person asked to forget their sign-ins while this browser was open: it keeps none when it closes. */
  forgetOnClose = false;
  /** Every file this browser downloaded, as saved to the Library. */
  files: RunFile[] = [];
  /** Set by whoever opened it: saves a download to the person's Library. */
  onFile?: (f: { name: string; type: string; bytes: Buffer }) => Promise<RunFile | null>;
  private frames = new Set<string>();
  private dls = new Map<string, { url: string; name: string; frameId: string; done: boolean; at?: number; early?: Promise<{ bytes: Buffer; type: string } | null> }>();
  private dlWork = new Set<Promise<unknown>>();

  constructor(
    readonly userId: string,
    private cdp: CdpConnection,
    private provider: ProviderHandle,
  ) {}

  // ---- starting ----

  /** Attach to a page and begin streaming it. */
  async begin(startUrl?: string): Promise<void> {
    const cdp = this.cdp;
    cdp.onClose(() => { void this.close("the browser connection closed").catch(() => {}); });
    if (!/\/devtools\/page\//.test(this.provider.wsUrl)) {
      let targetId = "";
      if (this.provider.kind === "hyperbrowser") {
        // A cloud session is this person's own browser, and starts with one page: use it.
        try {
          const list = await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
          targetId = list.targetInfos.find((t) => t.type === "page")?.targetId ?? "";
        } catch { /* make one */ }
      }
      if (!targetId && this.provider.kind === "cdp") {
        // A browser of your own may serve many people: each gets a context of its own (its own
        // cookies, logins and storage, thrown away when this connection ends), never the shared
        // one — or a second person would open it already signed in as the first.
        try {
          const proxyServer = env("BZ_BROWSER_PROXY");   // an egress proxy that refuses private ranges: the hard guard
          this.contextId = (await cdp.send<{ browserContextId: string }>("Target.createBrowserContext", { disposeOnDetach: true, ...(proxyServer ? { proxyServer } : {}) })).browserContextId;
        } catch {
          throw new BrowserError("start_failed", "That browser can't keep each person's pages apart, so BeeZilla won't use it.");
        }
        targetId = (await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", browserContextId: this.contextId })).targetId;
      }
      if (!targetId) targetId = (await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })).targetId;
      this.targetId = targetId;
      this.frames.add(targetId);          // a page's main frame has the page's own id
      // The sites the person signed in to last time (a browser of your own keeps them here, for a while).
      const jar = this.contextId && this.provider.keepsSignIns ? jarFor(this.userId) : null;
      if (jar?.length) {
        try { await cdp.send("Storage.setCookies", { cookies: jar, browserContextId: this.contextId }); } catch { /* a fresh start */ }
      }
      this.sid = (await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })).sessionId;
      // A link that opens a new window opens in this one: the person sees one page.
      try {
        await cdp.send("Target.setDiscoverTargets", { discover: true });
        this.stopHandlers.push(cdp.on("Target.targetCreated", (p) => void this.onNewTarget(p?.targetInfo)));
      } catch { /* optional */ }
      // Downloads (owner, 2026-11-23: "download the sound and send it elsewhere"): the browser says
      // when one starts and ends; the bytes are read through the browser itself (its address, its
      // sign-ins) and saved to the person's Library. A browser that can't save where this server
      // reads saves nothing at all.
      const dir = this.provider.downloadDir || "";
      try {
        await cdp.send("Browser.setDownloadBehavior", {
          behavior: dir ? "allowAndName" : "deny", ...(dir ? { downloadPath: dir } : {}), eventsEnabled: true,
          ...(this.contextId ? { browserContextId: this.contextId } : {}),
        });
        this.stopHandlers.push(
          cdp.on("Browser.downloadWillBegin", (p, sid) => { if (!sid) this.downloadBegins(p); }),
          cdp.on("Browser.downloadProgress", (p, sid) => { if (!sid && (p?.state === "completed" || p?.state === "canceled")) this.downloadEnds(String(p.guid ?? "")); }),
        );
      } catch { /* a browser without it: downloads just don't arrive */ }
    }
    const s = this.sid;
    await cdp.send("Page.enable", {}, s);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1, mobile: false }, s);
    try {
      await cdp.send("Network.enable", {}, s);
      await cdp.send("Network.setBlockedURLs", { urls: ["file://*", "ftp://*", "chrome://*", "chrome-extension://*", "view-source:*", ...(blockAds() && this.provider.kind === "cdp" ? AD_HOSTS : [])] }, s);
    } catch { /* optional */ }
    this.stopHandlers.push(
      cdp.on("Page.screencastFrame", (p, sid) => {
        if (sid !== this.sid) return;
        void cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }, this.sid).catch(() => {});
        this.takeFrame(String(p.data || ""), Number(p.metadata?.deviceWidth) || VIEW_W, Number(p.metadata?.deviceHeight) || VIEW_H);
      }),
      // A new page is a new world for the helpers (below).
      cdp.on("Page.frameNavigated", (p, sid) => {
        if (sid !== this.sid) return;
        if (p?.frame?.id && this.frames.size < 500) this.frames.add(String(p.frame.id));
        if (!p?.frame?.parentId) { this.world = null; this.lookSoon(); }
      }),
      cdp.on("Page.frameAttached", (p, sid) => { if (sid === this.sid && p?.frameId && this.frames.size < 500) this.frames.add(String(p.frameId)); }),
      // A "Download" that opens the file itself as the page (a song, a video, a PDF in a new tab,
      // followed here): the browser shows it instead of saving it, so it is kept like a download.
      cdp.on("Network.responseReceived", (p, sid) => {
        if (sid !== this.sid || p?.type !== "Document" || p?.frameId !== this.targetId) return;
        const mime = String(p?.response?.mimeType ?? "").toLowerCase();
        if (!/^(audio|video)\/|^application\/(pdf|zip|octet-stream)$/.test(mime)) return;
        // "attachment": the browser downloads it (and says so); only a file shown as the page is ours to keep.
        const headers = (p?.response?.headers ?? {}) as Record<string, string>;
        const cd = Object.entries(headers).find(([k]) => k.toLowerCase() === "content-disposition")?.[1] ?? "";
        if (/attachment/i.test(String(cd))) return;
        this.fileAsPage(String(p?.response?.url ?? ""), mime);
      }),
      cdp.on("Page.loadEventFired", (_p, sid) => { if (sid === this.sid) this.lookSoon(); }),
      cdp.on("Page.javascriptDialogOpening", (p, sid) => {
        if (sid !== this.sid) return;
        const kind = String(p?.type || "alert");
        const text = tidy(p?.message, 160);
        // An alert has to be dismissed and a page being left has to be left. A question (confirm,
        // prompt) is answered No: the person can't be asked in time, and saying OK to "delete
        // everything?" is not BeeZilla's call.
        const yes = kind === "alert" || kind === "beforeunload";
        void cdp.send("Page.handleJavaScriptDialog", { accept: yes, promptText: yes ? String(p?.defaultPrompt ?? "").slice(0, 200) : undefined }, this.sid).catch(() => {});
        this.emit({
          type: "notice",
          text: yes ? `The page showed a message${text ? `: “${text}”` : ""}. BeeZilla pressed OK.` : `The page asked${text ? `: “${text}”` : " a question"}. BeeZilla answered No, because it can't ask you in time.`,
        });
      }),
    );
    // Every page a link or a redirect opens (not just the ones typed in) is checked before it loads.
    if (!allowPrivate()) {
      try {
        await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] }, s);
        this.stopHandlers.push(cdp.on("Fetch.requestPaused", (p, sid) => { if (sid === this.sid) void this.vet(p).catch(() => {}); }));
      } catch { /* a browser without it: every address is still checked before the browser is sent there */ }
    }
    try { await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: KEEP_BLOBS, runImmediately: true }, s); } catch { /* downloads a page builds itself may be missed */ }
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 55, maxWidth: VIEW_W, maxHeight: VIEW_H, everyNthFrame: 1 }, s);
    // Where does this browser go out from? Asked of the browser itself, from a blank page,
    // so the answer is the one a website would see. It has to be asked before the first
    // page loads (a page's own rules could stop the question), so it is kept short.
    try {
      const w = await Promise.race([
        checkWhere((expr) => this.evalValue(expr, true), this.provider.label),
        new Promise<null>((r) => setTimeout(() => r(null), 5000)),
      ]);
      if (w) this.where = w;
    } catch { /* the window says it couldn't check */ }
    if (startUrl) {
      try { await this.navigateRaw(startUrl); } catch { /* the window shows the page it got to */ }
    }
    this.lookSoon();
  }

  private async onNewTarget(info: { targetId?: string; type?: string; openerId?: string; url?: string } | undefined) {
    if (!info || info.type !== "page" || info.targetId === this.targetId || info.openerId !== this.targetId || this.closed) return;
    this.popups++;
    try { await this.followPopup(info); } finally { this.popups--; }
  }
  /** A played step that opened a window waits until that window's page is showing here. */
  private async popupsDone() {
    await new Promise((r) => setTimeout(r, 450));
    const until = Date.now() + 7000;
    while (this.popups > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  }
  private async followPopup(info: { targetId?: string; url?: string }) {
    let url = String(info.url || "");
    for (let i = 0; i < 12 && (!url || url === "about:blank"); i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const t = await this.cdp.send<{ targetInfo: { url: string } }>("Target.getTargetInfo", { targetId: info.targetId });
        url = String(t.targetInfo?.url || "");
      } catch { break; }
    }
    try { await this.cdp.send("Target.closeTarget", { targetId: info.targetId }); } catch { /* gone */ }
    const ok = cleanUrl(url, 2000);
    // A link that opens a window is followed in this one, while recording and while playing.
    if (ok && !this.closed) {
      try { await this.navigateRaw(ok); } catch { /* ignore */ }
    }
  }
  /** A page about to load: let it, or stop it if it is inside. */
  private async vet(p: { requestId?: string; request?: { url?: string } }) {
    const requestId = String(p?.requestId ?? "");
    if (!requestId) return;
    let refuse = false;
    try { refuse = await mustRefuse(String(p.request?.url ?? "")); } catch { refuse = false; }
    try {
      if (refuse) {
        await this.cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, this.sid);
        this.emit({ type: "notice", text: "A page tried to open a private or internal address. BeeZilla's browser doesn't." });
      } else {
        await this.cdp.send("Fetch.continueRequest", { requestId }, this.sid);
      }
    } catch { /* the page is gone */ }
  }

  // ---- talking to the page ----

  private send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return this.cdp.send<T>(method, params, this.sid, timeoutMs);
  }
  /** Run an expression in the page itself (the blank page the address check starts from). */
  private async evalValue(expression: string, awaitPromise = false): Promise<unknown> {
    const r = await this.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise, timeout: 5000 }, awaitPromise ? 10_000 : 8000);
    return r.exceptionDetails ? undefined : r.result?.value;
  }
  /**
   * The helpers that read the page (what is under the pointer, what a box is called, where a
   * thing is) run in an isolated world: the page's own scripts can neither see them nor change
   * what they say, so a page can't pose a password box as a plain one. A new page needs a new
   * world, made on the first question.
   */
  private async ensureWorld(): Promise<number> {
    if (this.world) return this.world;
    const tree = await this.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
    const w = await this.send<{ executionContextId: number }>("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "bz-helper", grantUniveralAccess: false });
    const boot = await this.send<{ exceptionDetails?: unknown }>("Runtime.evaluate", { expression: `globalThis.__bz = ${PAGE_LIB}; 0`, contextId: w.executionContextId, returnByValue: true });
    if (boot.exceptionDetails) throw new Error("the page helpers could not start");
    this.world = w.executionContextId;
    return this.world;
  }
  private async page(fn: string, ...args: unknown[]): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const contextId = await this.ensureWorld();
        const r = await this.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression: call(fn, ...args), contextId, returnByValue: true, timeout: 5000 }, 8000);
        if (!r.exceptionDetails) return r.result?.value;
      } catch { /* the world went with a navigation: make it again */ }
      this.world = null;
    }
    return undefined;
  }
  /** One thing at a time: input arrives in bursts and must reach the page in order. */
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++;
    const run = this.opChain.then(fn, fn);
    const done = () => { this.pending--; };
    run.then(done, done);
    this.opChain = run.catch(() => {});
    return run;
  }
  /** How many things are waiting to reach the page (a flood is turned away by the route). */
  backlog(): number { return this.pending; }
  /** How many windows are watching this browser. */
  streamCount(): number { return this.listeners.size; }
  /** Seconds to count against the plan since the last time this was asked: every minute, and at the end. */
  bill(final = false): number {
    const sec = Math.floor((Date.now() - this.billedAt) / 1000);
    if (sec < (final ? 1 : 60)) return 0;
    this.billedAt += sec * 1000;
    try { this.onBill?.(sec); } catch { /* accounting never blocks */ }
    return sec;
  }

  // ---- frames ----

  private takeFrame(b64: string, w: number, h: number) {
    if (!b64 || this.closed) return;
    this.frame = { seq: ++this.seq, w, h, b64 };
    if (this.frameTimer) return;
    // At most about eight pictures a second: a person can't use more, and each is 50 KB or so.
    const wait = Math.max(0, 125 - (Date.now() - this.frameSent));
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null;
      this.frameSent = Date.now();
      if (this.frame) this.emit({ type: "frame", ...this.frame });
    }, wait);
  }
  /** A picture right now, for someone who has just joined (or when the page is still). */
  async currentFrame(): Promise<SessionEvent | null> {
    if (this.frame) return { type: "frame", ...this.frame };
    try {
      const shot = await this.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 55 }, 10_000);
      if (shot.data) {
        this.frame = { seq: ++this.seq, w: VIEW_W, h: VIEW_H, b64: shot.data };
        return { type: "frame", ...this.frame };
      }
    } catch { /* no picture yet */ }
    return null;
  }

  // ---- events out ----

  /**
   * Watch this browser. A person has one window on it; a few more are room for a reload. A fourth
   * takes the place of the oldest (a connection left half-open by a network blip must not shut the
   * person out of their own browser), which is told it was dropped.
   */
  subscribe(fn: Listener, onDrop?: () => void): () => void {
    while (this.listeners.size >= 3) {
      const oldest = this.listeners.keys().next().value as Listener | undefined;
      if (!oldest) break;
      const drop = this.listeners.get(oldest);
      this.listeners.delete(oldest);
      try { drop?.(); } catch { /* it is gone either way */ }
    }
    this.listeners.set(fn, onDrop);
    return () => { this.listeners.delete(fn); };
  }
  private emit(ev: SessionEvent) {
    for (const l of [...this.listeners.keys()]) {
      try { l(ev); } catch { this.listeners.delete(l); }
    }
  }
  hello(): SessionEvent {
    return {
      type: "hello", id: this.id, view: { w: VIEW_W, h: VIEW_H }, recording: this.recording, steps: this.steps, url: this.url, title: this.title,
      where: this.where, replaying: this.replaying, canBack: this.canBack, canForward: this.canForward,
      maxSeconds: Math.round(this.maxMs / 1000), idleSeconds: idleSeconds(), label: this.provider.label,
      run: this.run ? { kind: this.run.kind, by: this.run.by, task: this.run.task, nodeId: this.run.nodeId, acts: this.run.acts.slice(-60) } : null,
      files: this.files.slice(-12),
      signIns: !!this.provider.keepsSignIns,
    };
  }

  // ---- where it is now ----

  private lookSoon() {
    if (this.navTimer || this.closed) return;
    this.navTimer = setTimeout(() => { this.navTimer = null; void this.look(); }, 250);
  }
  private async look() {
    if (this.closed) return;
    try {
      // The address and title come from the browser itself (a small answer), never from the page: a
      // page could otherwise put any address in the window's address bar. (The whole history is not
      // asked for: a page can make it enormous.)
      let url = this.url;
      let title = this.title;
      if (this.targetId) {
        const t = await this.cdp.send<{ targetInfo: { url?: string; title?: string } }>("Target.getTargetInfo", { targetId: this.targetId }, undefined, 5000);
        url = tidy(t.targetInfo?.url ?? url, 2000);
        title = tidy(t.targetInfo?.title ?? title, 140);
      }
      const nav = (await this.page("nav")) as { api?: boolean; back?: boolean; fwd?: boolean } | undefined;
      const canBack = nav?.back === true;
      const canForward = nav?.fwd === true;
      if (url !== this.url || title !== this.title || canBack !== this.canBack || canForward !== this.canForward) {
        this.url = url; this.title = title; this.canBack = canBack; this.canForward = canForward;
        this.emit({ type: "nav", url, title, canBack, canForward });
      }
    } catch { /* the page is mid-navigation: the next event asks again */ }
  }

  // ---- recording ----

  /** The pause since the last thing that was recorded, capped. */
  private gap(): number {
    const now = Date.now();
    const ms = this.lastStepAt ? now - this.lastStepAt : 0;
    this.lastStepAt = now;
    return Math.min(30_000, ms);
  }
  private addStep(step: BrowserStep) {
    if (!this.recording || this.closed) return;
    if (this.steps.length >= MAX_STEPS) {
      this.recording = false;
      this.emit({ type: "rec", on: false });
      this.emit({ type: "notice", text: `That's as many steps as one node holds (${MAX_STEPS}). Recording stopped.` });
      return;
    }
    const clean = cleanSteps([{ ...step, url: step.url ?? this.url, ms: step.ms ?? this.gap() }])[0];
    if (!clean) return;
    this.steps.push(clean);
    this.emit({ type: "step", i: this.steps.length - 1, step: clean });
  }
  /** Start or stop recording. Stopping first writes down whatever was half-typed. */
  async setRecording(on: boolean, keep = false): Promise<void> {
    if (on === this.recording || this.closed) return;
    if (on) {
      if (!keep) { this.steps = []; this.emit({ type: "steps", steps: [] }); }
      this.recording = true;
      this.lastStepAt = Date.now();
      // Recording from a page that is already open: the first step is going to that page.
      if (this.steps.length === 0 && /^https?:/i.test(this.url)) this.addStep({ t: "goto", say: wordsForGoto(this.url), url: this.url, ms: 0 });
    } else {
      await this.queue(() => this.flushAll());
      this.recording = false;
    }
    this.emit({ type: "rec", on: this.recording });
  }
  deleteStep(i: number) {
    if (!Number.isInteger(i) || i < 0 || i >= this.steps.length) return;
    this.steps.splice(i, 1);
    this.emit({ type: "steps", steps: this.steps });
  }
  /** Put steps back (a node the person opened again to add to). */
  loadSteps(steps: unknown) {
    this.steps = cleanSteps(steps);
    this.emit({ type: "steps", steps: this.steps });
  }

  private async flushAll() {
    this.flushScroll();
    await this.flushType();
  }
  private flushScroll() {
    if (this.scrollTimer) { clearTimeout(this.scrollTimer); this.scrollTimer = null; }
    const s = this.scrolled;
    this.scrolled = null;
    if (!s || Math.abs(s.dy) < 40) return;
    this.addStep({ t: "scroll", say: s.dy > 0 ? "Scroll down" : "Scroll up", dy: Math.round(s.dy) });
  }
  private async flushType() {
    if (this.typingTimer) { clearTimeout(this.typingTimer); this.typingTimer = null; }
    const t = this.typing;
    this.typing = null;
    if (!t || !this.recording) return;
    let value = "";
    let moved = false;
    const seen: Seen = { ...t.seen };
    if (!seen.secret) {
      try {
        const r = (await this.page("value")) as { v?: string; moved?: boolean; secret?: boolean } | null | undefined;
        if (r?.moved) moved = true;
        else if (r?.secret) seen.secret = true;      // the box turned out to be a secret one
        else value = String(r?.v ?? "");
      } catch { value = ""; }
    }
    // The click that put the cursor in this very box is part of the typing.
    const last = this.steps[this.steps.length - 1];
    if (last && last.t === "click" && last.on && seen.sel && last.on.sel === seen.sel) {
      this.steps.pop();
      this.emit({ type: "steps", steps: this.steps });
    }
    if (moved) {
      // The cursor jumped to another box by itself (an expiry date that moves on to the security
      // code): what was typed may belong to a secret box, so none of it is written down.
      this.emit({ type: "notice", text: "The cursor moved on by itself while you typed, so what you typed there wasn't written down (it might have been a password or a code)." });
      return;
    }
    if (!seen.secret && value === "") return;
    this.addStep({
      t: "type", say: wordsForType(seen), on: hintOf(seen), secret: seen.secret === true ? true : undefined,
      v: seen.secret ? undefined : value, x: seen.x, y: seen.y,
    });
  }
  private async noteTyping() {
    if (!this.recording) return;
    if (!this.typing) {
      let seen: Seen | null = null;
      try { seen = (await this.page("arm")) as Seen | null; } catch { seen = null; }
      if (!seen || !seen.editable) { this.typing = null; return; }
      this.typing = { seen, at: Date.now() };
    }
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => { void this.queue(() => this.flushType()); }, 1400);
  }

  // ---- input ----

  async input(events: InputEvent[]): Promise<void> {
    // While BeeZilla does a job the browser is its: Stop hands it back.
    if (this.closed || this.replaying || this.run) return;
    this.lastInput = Date.now();
    // All of a batch goes into the line at once, so a second batch that arrives while this
    // one is still being passed on can never get in between its events.
    let last: Promise<unknown> = Promise.resolve();
    for (const ev of events.slice(0, 80)) last = this.queue(() => this.one(ev));
    try { await last; } catch { /* one input the page or the browser refused must not stop the next */ }
  }

  private async one(ev: InputEvent): Promise<void> {
    if (this.closed) return;
    const x = Math.max(0, Math.min(VIEW_W - 1, Math.round(Number((ev as { x?: number }).x) || 0)));
    const y = Math.max(0, Math.min(VIEW_H - 1, Math.round(Number((ev as { y?: number }).y) || 0)));
    if (ev.type === "mouse") {
      const mods = Number(ev.mods) || 0;
      const button = ev.button === "right" || ev.button === "middle" ? ev.button : "left";
      if (ev.action === "move") {
        await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: ev.buttons ? button : "none", buttons: Number(ev.buttons) || 0, modifiers: mods });
        return;
      }
      if (ev.action === "down") {
        await this.flushAll();
        let seen: Seen | null = null;
        try { seen = (await this.page("describeAt", x, y)) as Seen | null; } catch { seen = null; }
        // A list (a <select>) draws its choices outside the page, where a screencast can't
        // see them: offer them in the window instead.
        if (seen?.choice && button === "left") {
          try {
            const o = (await this.page("options", x, y)) as { options: { i: number; text: string; selected: boolean }[]; name: string } | null;
            if (o && Array.isArray(o.options) && o.options.length) {
              this.downAt = null;
              const options = o.options.slice(0, 60).map((op, n) => ({ i: Number.isInteger(op.i) ? op.i : n, text: tidy(op.text, 80), selected: op.selected === true }));
              this.emit({ type: "pick", options, name: plain(o.name, 60), x, y });
              return;
            }
          } catch { /* click it like anything else */ }
        }
        this.downAt = { x, y, seen };
        await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons: button === "left" ? 1 : button === "right" ? 2 : 4, clickCount: Math.max(1, Number(ev.clickCount) || 1), modifiers: mods });
        return;
      }
      await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, clickCount: Math.max(1, Number(ev.clickCount) || 1), modifiers: mods });
      const d = this.downAt;
      this.downAt = null;
      if (d && this.recording && button === "left" && Math.abs(d.x - x) + Math.abs(d.y - y) < 10) {
        this.addStep({ t: "click", say: wordsForClick(d.seen), on: hintOf(d.seen), x: d.seen?.x ?? d.x, y: d.seen?.y ?? d.y });
      }
      this.lookSoon();
      return;
    }
    if (ev.type === "wheel") {
      await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: Math.max(-3000, Math.min(3000, Number(ev.dx) || 0)), deltaY: Math.max(-3000, Math.min(3000, Number(ev.dy) || 0)), modifiers: Number(ev.mods) || 0 });
      if (this.recording) {
        const dy = Number(ev.dy) || 0;
        this.scrolled = { dy: (this.scrolled?.dy ?? 0) + dy };
        if (this.scrollTimer) clearTimeout(this.scrollTimer);
        this.scrollTimer = setTimeout(() => this.flushScroll(), 700);
      }
      return;
    }
    if (ev.type === "key") {
      const key = String(ev.key || "").slice(0, 24);
      if (!key) return;
      const mods = Number(ev.mods) || 0;
      // Copy, cut and paste by keyboard use the browser's own clipboard, which on a browser shared
      // by several people would carry one person's text to the next. Pasting from the person's own
      // clipboard arrives as typed text (type "text"), not as these keys.
      const lowered = key.toLowerCase();
      if (((mods & 6) && (lowered === "c" || lowered === "x" || lowered === "v" || lowered === "insert")) || ((mods & 8) && (key === "Delete" || key === "Insert"))) return;
      if (ev.action === "up") {
        await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: String(ev.code || "").slice(0, 24), windowsVirtualKeyCode: keyCodeFor(key), modifiers: mods });
        return;
      }
      const printable = key.length === 1 && !(mods & 6);        // no Ctrl, no Command
      const commands = (Array.isArray(ev.commands) ? ev.commands : []).filter((c) => EDIT_COMMANDS.has(c));
      if (isRecordedKey(key) && !(mods & 6)) await this.flushAll();
      await this.send("Input.dispatchKeyEvent", {
        type: printable || key === "Enter" ? "keyDown" : "rawKeyDown",
        key, code: String(ev.code || "").slice(0, 24), text: printable ? key : key === "Enter" ? "\r" : undefined,
        unmodifiedText: printable ? key : key === "Enter" ? "\r" : undefined,
        windowsVirtualKeyCode: keyCodeFor(key), modifiers: mods, commands: commands.length ? commands : undefined,
      });
      if (isRecordedKey(key) && !(mods & 6)) {
        // Shift+Enter is not Enter (a chat box that sends on Enter and breaks the line on Shift+Enter).
        const named = `${mods & 8 ? "Shift+" : ""}${mods & 1 ? "Alt+" : ""}${key}`;
        this.addStep({ t: "key", say: `Press ${named}`, key: named });
        this.lookSoon();
      } else if (printable || key === "Backspace" || key === "Delete" || commands.includes("paste") || commands.includes("cut")) {
        await this.noteTyping();
      }
      return;
    }
    if (ev.type === "text") {
      const text = String(ev.text ?? "").slice(0, 4000);
      if (!text) return;
      await this.send("Input.insertText", { text });
      await this.noteTyping();
      return;
    }
    if (ev.type === "choose") {
      const r = (await this.page("pick", x, y, Math.max(0, Math.floor(Number(ev.index) || 0)))) as { text: string; name: string } | null;
      if (r && this.recording) {
        let seen: Seen | null = null;
        try { seen = (await this.page("describeAt", x, y)) as Seen | null; } catch { seen = null; }
        this.addStep({ t: "select", say: r.name ? `Choose from the list “${plain(r.name, 50)}”` : "Choose from a list", on: hintOf(seen), v: tidy(r.text, 80), x: seen?.x ?? x, y: seen?.y ?? y });
      }
      return;
    }
  }

  // ---- going places ----

  private async navigateRaw(url: string): Promise<void> {
    if (await mustRefuse(url)) throw new BrowserError("bad_request", "BeeZilla's browser doesn't open private or internal addresses.");
    const r = await this.send<{ errorText?: string }>("Page.navigate", { url }, 30_000);
    if (r.errorText) throw new BrowserError("bad_request", "That page could not be opened.");
  }

  /** The address bar: a web address, typed or pasted. */
  async goto(raw: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    let s = String(raw ?? "").trim();
    if (!s) return { ok: false, error: "Type a web address first." };
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s;
    const url = cleanUrl(s, 2000);
    let host = "";
    try { host = new URL(url).hostname.replace(/^\[|\]$/g, ""); } catch { /* not an address */ }
    if (!url || (!host.includes(".") && !isIP(host) && !allowPrivate())) return { ok: false, error: "That doesn't look like a web address. Try something like example.com" };
    if (await mustRefuse(url)) return { ok: false, error: "BeeZilla's browser doesn't open private or internal addresses." };
    if (this.replaying) return { ok: false, error: "BeeZilla is playing the steps. Wait for it to finish." };
    this.lastInput = Date.now();
    await this.queue(async () => {
      await this.flushAll();
      this.addStep({ t: "goto", say: wordsForGoto(url), url });
      try { await this.navigateRaw(url); } catch { this.emit({ type: "notice", text: "That page could not be opened." }); }
    });
    this.lookSoon();
    return { ok: true, url };
  }

  async history(action: "back" | "forward" | "reload"): Promise<void> {
    this.lastInput = Date.now();
    await this.queue(async () => {
      await this.flushAll();
      if (action === "reload") { await this.send("Page.reload", {}); return; }
      await this.page("go", action === "back" ? -1 : 1);
      if (action === "back") this.addStep({ t: "back", say: "Go back one page" });
    });
    this.lookSoon();
  }

  // ---- playing a recording back ----

  private async settle(maxMs: number) {
    const until = Date.now() + maxMs;
    await new Promise((r) => setTimeout(r, 350));
    while (Date.now() < until) {
      const state = await this.page("ready");
      if (state === "complete") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  private async clickAt(x: number, y: number) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  }

  private async pressKey(key: string, modifiers = 0) {
    const text = key === "Enter" ? "\r" : key === " " ? " " : undefined;
    await this.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code: key === " " ? "Space" : undefined, windowsVirtualKeyCode: keyCodeFor(key), modifiers, text, unmodifiedText: text });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: keyCodeFor(key), modifiers });
  }
  /** Everything in the box that has the cursor, selected, so what is typed next replaces it. */
  private async selectAll() {
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2, commands: ["selectAll"] });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  }
  /** Run a helper that answers later (a download being read). */
  private async pageWait(fn: string, timeoutMs: number, ...args: unknown[]): Promise<unknown> {
    const contextId = await this.ensureWorld();
    const r = await this.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression: call(fn, ...args), contextId, returnByValue: true, awaitPromise: true, timeout: timeoutMs }, timeoutMs + 3000);
    return r.exceptionDetails ? undefined : r.result?.value;
  }

  // ---- jobs: a recording played, or a task BeeZilla does itself ----

  /** Sign out of every site in this browser now, and keep nothing when it closes. */
  async forgetNow(): Promise<void> {
    this.forgetOnClose = true;
    try { await this.cdp.send("Storage.clearCookies", this.contextId ? { browserContextId: this.contextId } : {}, undefined, 5000); } catch { /* it closes soon enough */ }
  }
  /** Is a job or a played recording going on? */
  busy(): boolean { return this.replaying || !!this.run; }
  /** Stop the job going on (the person pressed Stop, or the page is closing). */
  stopRun(): boolean {
    if (!this.run) return false;
    this.run.stop = true;
    return true;
  }
  /** Asked between steps: should the job stop now? */
  stopRequested(): boolean { return this.closed || !!this.run?.stop; }
  isClosed(): boolean { return this.closed; }
  /** Mark the start of a job. Throws when one is already going on. */
  beginRun(kind: BrowserMode, by: RunBy, task?: string, nodeId?: string): number {
    if (this.closed) throw new BrowserError("gone", "That browser has closed.");
    if (this.run) throw new BrowserError("busy", "BeeZilla's browser is already doing a job. Wait for it, or press Stop.");
    const node = nodeId && /^[A-Za-z0-9_:-]{1,80}$/.test(nodeId) ? nodeId : undefined;
    this.run = { kind, by, task: task ? tidy(task, 400) : undefined, nodeId: node, stop: false, started: Date.now(), firstFile: this.files.length, acts: [] };
    this.lastInput = Date.now();
    this.emit({ type: "run", state: "start", kind, by, task: this.run.task, nodeId: node });
    return this.files.length;
  }
  /** One thing a job did, for the window (a list that fills in as it works). */
  noteAct(i: number, say: string, state: "running" | "ok" | "failed", note?: string) {
    if (!this.run) return;
    const acts = this.run.acts;
    const at = acts.findIndex((x) => x.i === i);
    const row = { i, say: tidy(say, 160), state, note: note ? tidy(note, 200) : undefined };
    if (at >= 0) acts[at] = row; else acts.push(row);
    if (acts.length > 80) acts.shift();
    this.lastInput = Date.now();
    this.emit({ type: "act", ...row });
  }
  /** End a job: wait for its downloads, read where it ended, tell everyone watching. */
  async endRun(base: Omit<RunResult, "files" | "finalUrl" | "title" | "text" | "seconds">, firstFile: number): Promise<RunResult> {
    await this.downloadsSettled(45_000);
    let text = "";
    try {
      await this.look();
      text = plain(await this.page("readText"), 700);
    } catch { /* the page is gone: say what we know */ }
    const started = this.run?.started ?? Date.now();
    const result: RunResult = {
      ...base,
      nodeId: this.run?.nodeId,
      files: this.files.slice(firstFile),
      // Where it ended up is the one address never cleaned on the way here (a job can finish on
      // ?token=…): the value is taken out at the source, for the card and BeeZilla alike (review 4).
      finalUrl: stripSecretQuery(this.url).url, title: plain(this.title, 140), text,
      seconds: Math.max(0, Math.round((Date.now() - started) / 1000)),
    };
    this.run = null;
    this.lastInput = Date.now();
    this.emit({ type: "run", state: "end", result });
    this.lookSoon();
    return result;
  }

  /** The page as BeeZilla sees it while doing a job: numbered things to act on, and its words. */
  async observe(): Promise<PageView | null> {
    if (this.closed) return null;
    await this.look();
    const raw = (await this.page("snapshot", 90)) as { els?: unknown[]; text?: string; below?: number; above?: number } | undefined;
    if (!raw) return null;
    const els: PageView["els"] = [];
    for (const x of Array.isArray(raw.els) ? raw.els.slice(0, 90) : []) {
      const e = (x ?? {}) as Record<string, unknown>;
      const row: PageView["els"][number] = { i: Math.max(0, Math.floor(Number(e.i) || 0)), tag: tidy(e.tag, 12).toLowerCase() };
      if (e.role) row.role = tidy(e.role, 20);
      if (e.name) row.name = plain(e.name, 80);
      if (e.type) row.type = tidy(e.type, 16);
      if (e.ph) row.ph = plain(e.ph, 60);
      if (e.value && e.secret !== true) row.value = plain(e.value, 80);
      if (e.href) row.href = plain(e.href, 100);
      if (e.inView === true) row.inView = true;
      if (e.secret === true) row.secret = true;
      if (e.editable === true) row.editable = true;
      if (e.disabled === true) row.disabled = true;
      if (typeof e.checked === "boolean") row.checked = e.checked;
      if (Array.isArray(e.options)) row.options = e.options.slice(0, 15).map((o) => plain(o, 40));
      if (e.file === true) row.file = true;
      if (typeof e.expanded === "boolean") row.expanded = e.expanded;
      els.push(row);
    }
    const downloading = [...this.dls.values()].filter((d) => !d.done).length + this.dlWork.size;
    return {
      url: this.url, title: plain(this.title, 140), els, text: plain(raw.text, 3000),
      below: Math.max(0, Math.floor(Number(raw.below) || 0)), above: Math.max(0, Math.floor(Number(raw.above) || 0)),
      // Only what this job downloaded: a file from an earlier job is not this one's result.
      files: this.files.slice(this.run ? this.run.firstFile : this.files.length).slice(-8), downloading,
    };
  }
  /** Would Enter or Space press something that is the person's to press (a form's Pay button)? */
  private async enterIsPersons(): Promise<string | null> {
    const names = (await this.page("wouldPress")) as string[] | undefined;
    for (const n of Array.isArray(names) ? names : []) {
      const stop = personOnly(String(n));
      if (stop) return stop;
    }
    return null;
  }
  private async mark(i: number): Promise<(Seen & { x: number; y: number; covered?: boolean; coveredBy?: string; overlay?: boolean; hitName?: string; disabled?: boolean; file?: boolean; hidden?: boolean }) | null> {
    if (!Number.isInteger(i) || i < 0 || i > 500) return null;
    const d = (await this.page("markAt", i)) as (Seen & { x: number; y: number }) | null | undefined;
    return d && typeof d.x === "number" ? d : null;
  }

  /**
   * Do one thing on the page for a job. The rules that keep the person safe are here, in code,
   * whatever the model asked for: no password, card or code is ever typed by BeeZilla, no
   * button that pays, buys, subscribes or changes the account is pressed, no private address
   * is opened. Each thing done comes back as steps, so a job can be kept as a recording.
   */
  async act(a: AgentAction, opts: { details?: string; loadFile?: (name: string) => Promise<{ name: string; type: string; bytes: Buffer } | null>; sites?: string[] } = {}): Promise<ActOutcome & { steps?: BrowserStep[] }> {
    if (this.closed) return { ok: false, note: "The browser has closed." };
    this.lastInput = Date.now();
    try {
      if (a.do === "goto") {
        let u = String(a.url ?? "").trim();
        if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = "https://" + u;
        const url = cleanUrl(u, 2000);
        if (!url) return { ok: false, note: "That isn't a web address." };
        if (await mustRefuse(url)) return { ok: false, note: "BeeZilla's browser doesn't open private or internal addresses." };
        // A job opens only the sites its own words name (and the site it is on): a page's words can't
        // send it somewhere else with what it has seen. Links on the page are still followed by clicking.
        if (opts.sites && !siteAllowed(url, [...opts.sites, this.url])) {
          return { ok: false, note: "BeeZilla only opens the sites the job names. To go elsewhere, follow a link on this page." };
        }
        await this.navigateRaw(url);
        await this.settle(15_000);
        await this.look();
        return { ok: true, note: `Opened ${tidy(hostPath(this.url || url), 90)}`, steps: [{ t: "goto", say: wordsForGoto(url), url }] };
      }
      if (a.do === "back") {
        await this.page("go", -1);
        await this.settle(8000);
        return { ok: true, note: "Went back a page", steps: [{ t: "back", say: "Go back one page" }] };
      }
      if (a.do === "scroll") {
        const dy = a.dir === "up" ? -600 : 600;
        await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: VIEW_W / 2, y: VIEW_H / 2, deltaX: 0, deltaY: dy });
        await new Promise((r) => setTimeout(r, 500));
        return { ok: true, note: dy > 0 ? "Scrolled down" : "Scrolled up", steps: [{ t: "scroll", say: dy > 0 ? "Scroll down" : "Scroll up", dy }] };
      }
      if (a.do === "wait") {
        const n = Math.max(1, Math.min(60, Math.round(Number(a.seconds) || 5)));
        for (let k = 0; k < n * 2 && !this.stopRequested(); k++) {
          await new Promise((r) => setTimeout(r, 500));
          this.lastInput = Date.now();
        }
        return { ok: true, note: `Waited ${n} seconds`, steps: [{ t: "wait", say: `Wait ${n} seconds for the page`, wait: n }] };
      }
      if (a.do === "press") {
        const key = String(a.key ?? "").trim().replace(/^space(bar)?$/i, " ").replace(/^(esc)$/i, "Escape").replace(/^return$/i, "Enter");
        const named = key === " " ? " " : key.charAt(0).toUpperCase() + key.slice(1);
        if (!isJobKey(named)) return { ok: false, note: `BeeZilla can't press ${tidy(a.key, 20)} on a page.` };
        if (named === "Enter" || named === " ") {
          const stop = await this.enterIsPersons();
          if (stop) return { ok: false, note: stop, needs: stop };
        }
        await this.pressKey(named);
        await this.settle(6000);
        return { ok: true, note: `Pressed ${named === " " ? "Space" : named}`, steps: [{ t: "key", say: `Press ${named === " " ? "Space" : named}`, key: named }] };
      }
      const d = await this.mark(a.el);
      if (!d) return { ok: false, note: `Thing [${a.el}] isn't on the page any more. Look at the page again.` };
      const label = called(d) || "that";
      if (a.do === "upload") {
        if (!opts.loadFile) return { ok: false, note: "There is no file to hand over in this job." };
        const f = await opts.loadFile(String(a.file ?? ""));
        if (!f) return { ok: false, note: `There's no file called “${plain(a.file, 60)}” to hand over. Use one of the files listed.` };
        if (f.bytes.length > MAX_DOWNLOAD_BYTES) return { ok: false, note: "That file is too big to hand to a page." };
        const id = randomBytes(6).toString("hex");
        const b64 = f.bytes.toString("base64");
        for (let at = 0, first = true; at < b64.length; at += 3_000_000, first = false) {
          await this.page("filePart", id, b64.slice(at, at + 3_000_000), first);
        }
        const r = (await this.page("giveFile", a.el, id, f.name, f.type)) as { ok?: boolean; how?: string } | undefined;
        if (!r?.ok) return { ok: false, note: `The page didn't take the file at ${label}.` };
        await this.settle(8000);
        return { ok: true, note: `Gave the page “${plain(f.name, 60)}”${r.how === "drop" ? " (dropped on it)" : ""}` };
      }
      if (d.file) return { ok: false, note: `${label} is for choosing a file: use upload with the file's name instead.` };
      if (a.do === "click") {
        // The thing's own name, and what a click there would really press if something covers it.
        const stop = personOnly(d.name || d.placeholder) ?? (d.covered ? personOnly(d.hitName) : null);
        if (stop) return { ok: false, note: stop, needs: stop };
        if (d.disabled) return { ok: false, note: `${label} is greyed out right now: the page isn't ready for it (wait, or do what it needs first).` };
        if (d.covered && !d.overlay && d.type !== "checkbox" && d.type !== "radio") {
          return { ok: false, note: `A pop-up${d.coveredBy && d.coveredBy !== "a pop-up" ? ` (“${plain(d.coveredBy, 50)}”)` : ""} is in front of ${label}: close it or answer it first.` };
        }
        // A see-through layer over the button: the button itself is pressed.
        if (d.covered && d.overlay) await this.page("pressAt", a.el);
        else await this.clickAt(d.x, d.y);
        await this.popupsDone();
        await this.settle(8000);
        return { ok: true, note: `Clicked ${label}`, steps: [{ t: "click", say: wordsForClick(d), on: hintOf(d), x: d.x, y: d.y }] };
      }
      if (a.do === "type") {
        if (d.secret) {
          const why = `${label === "that" ? "That box" : label} is for a password, a card or a code. BeeZilla never types those: sign in yourself, once, in BeeZilla's browser (open the globe on the board and type it in the picture). It stays signed in after that.`;
          return { ok: false, note: why, needs: why };
        }
        if (!d.editable) return { ok: false, note: `${label} isn't a box to type in.` };
        if (d.covered && !d.overlay) return { ok: false, note: `A pop-up is in front of ${label}: close it or answer it first.` };
        const text = String(a.text ?? "").slice(0, 4000);
        if (!d.covered) await this.clickAt(d.x, d.y);
        await new Promise((r) => setTimeout(r, 150));
        // The words go only where the cursor really is, and only if that is this box and not a secret
        // one: a page can lay a password box over a plain one, or move the cursor away.
        let f = (await this.page("focusIs", a.el)) as { ok?: boolean; secret?: boolean } | undefined;
        if (!f?.ok) { await this.page("focusMark", a.el); f = (await this.page("focusIs", a.el)) as typeof f; }
        if (f?.secret) {
          const why = "The cursor is in a box for a password, a card or a code. BeeZilla never types those: sign in yourself, once, in BeeZilla's browser.";
          return { ok: false, note: why, needs: why };
        }
        if (!f?.ok) return { ok: false, note: `The cursor didn't go into ${label}. Look at the page again.` };
        await this.selectAll();
        if (text) await this.send("Input.insertText", { text });
        else await this.pressKey("Backspace");
        const steps: BrowserStep[] = [];
        const blank = blankFor(text, opts.details, d);
        steps.push({ t: "type", say: wordsForType(d), on: hintOf(d), v: text, x: d.x, y: d.y, ...(blank ? { blank } : {}) });
        if (a.enter) {
          const stop = await this.enterIsPersons();
          if (stop) return { ok: false, note: `Typed into ${label}, then stopped: ${stop}`, needs: stop, steps };
          await this.pressKey("Enter");
          await this.settle(8000);
          steps.push({ t: "key", say: "Press Enter", key: "Enter" });
        } else await new Promise((r) => setTimeout(r, 300));
        return { ok: true, note: `Typed into ${label}${a.enter ? " and pressed Enter" : ""}`, steps };
      }
      if (a.do === "select") {
        const r = (await this.page("chooseAt", a.el, String(a.option ?? ""))) as { text: string; name: string } | null | undefined;
        if (!r) return { ok: false, note: `${label} has no choice “${plain(a.option, 40)}”.` };
        await this.settle(4000);
        return { ok: true, note: `Chose “${plain(r.text, 40)}” in ${label}`, steps: [{ t: "select", say: r.name ? `Choose from the list “${plain(r.name, 50)}”` : "Choose from a list", on: hintOf(d), v: tidy(r.text, 80), x: d.x, y: d.y }] };
      }
      return { ok: false, note: "BeeZilla can't do that on a page." };
    } catch (e) {
      return { ok: false, note: e instanceof BrowserError ? e.message : "The browser stopped answering." };
    }
  }

  /** Play steps in this browser, the way a person would, and say how far it got. */
  async replay(raw: unknown, opts: { fill?: Record<string, string>; by?: RunBy; nodeId?: string } = {}): Promise<RunResult> {
    const by = opts.by ?? "you";
    const steps = cleanSteps(raw);
    const none = (note: string): RunResult => ({ ok: false, kind: "recording", by, note, ran: 0, files: [], finalUrl: this.url, title: plain(this.title, 140), text: "", seconds: 0 });
    if (this.closed) return none("The browser has closed.");
    if (this.replaying || this.run) return none("BeeZilla's browser is already doing a job. Wait for it, or press Stop.");
    if (!steps.length) { this.emit({ type: "notice", text: "There's nothing recorded to play yet." }); return none("There's nothing recorded to play yet."); }
    // Marked at once, before anything waits: a second request can't start a second play.
    this.replaying = true;
    const firstFile = this.beginRun("recording", by, undefined, opts.nodeId);
    const fill = cleanFill(opts.fill);
    await this.queue(() => this.flushAll());
    await this.setRecording(false);
    let skipped = 0, ran = 0, failedAt: number | undefined, note = "", needs: string | undefined, stopped = false;
    try {
      for (let i = 0; i < steps.length; i++) {
        if (this.stopRequested()) {
          // (Read through a method: the checks above can't see a Stop that arrives while this runs.)
          if (this.isClosed()) note = "The browser closed."; else { stopped = true; note = "You stopped it."; }
          failedAt = i;
          break;
        }
        const st = steps[i]!;
        this.lastInput = Date.now();
        this.emit({ type: "replay", i, state: "running" });
        if (st.secret && st.t === "type") {
          skipped++;
          this.emit({ type: "replay", i, state: "skipped", note: "You enter this yourself — it was never recorded." });
          continue;
        }
        const r = await this.play(st, fill);
        if (r.needs || r.failed) {
          failedAt = i;
          note = (r.needs || r.failed)!;
          needs = r.needs;
          this.emit({ type: "replay", i, state: "failed", note });
          break;
        }
        ran = i + 1;
        this.emit({ type: "replay", i, state: "ok" });
      }
    } catch {
      note = "The browser stopped answering.";
      failedAt = failedAt ?? ran;
    }
    const ok = failedAt === undefined && !stopped;
    if (ok) note = skipped ? `Played every step. ${skipped} ${skipped === 1 ? "step was" : "steps were"} left for you (passwords and codes are never recorded).` : "Played every step.";
    this.replaying = false;
    const result = await this.endRun({ ok, kind: "recording", by, note, needs, stopped: stopped || undefined, failedAt, ran }, firstFile);
    this.emit({ type: "replay-done", ok, failedAt, note, steps: ran, finalUrl: result.finalUrl, title: result.title, text: result.text });
    return result;
  }

  /**
   * One step. A thing to click or type into is waited for — a page that is still making the
   * song shows its Download button later — for about twice as long as the person waited when
   * they recorded it (8 seconds to 3 minutes), and a greyed-out one is waited for too.
   */
  private async play(st: BrowserStep, fill: Record<string, string>): Promise<{ failed?: string; needs?: string }> {
    try {
      if (st.t === "goto" && st.url) {
        await this.navigateRaw(st.url);
        await this.settle(12_000);
        return {};
      }
      if (st.t === "back") {
        await this.page("go", -1);
        await this.settle(8000);
        return {};
      }
      if (st.t === "wait") {
        const n = Math.max(1, Math.min(300, st.wait ?? 5));
        for (let k = 0; k < n * 2 && !this.stopRequested(); k++) { await new Promise((r) => setTimeout(r, 500)); this.lastInput = Date.now(); }
        return {};
      }
      if (st.t === "key" && st.key) {
        const parts = st.key.split("+");
        const key = parts[parts.length - 1]!;
        if (!isRecordedKey(key) && !isJobKey(key)) return { failed: `I can't press ${tidy(st.key, 20)}.` };
        if (key === "Enter" || key === " ") {
          const stop = await this.enterIsPersons();
          if (stop) return { needs: stop };
        }
        await this.pressKey(key, (parts.includes("Shift") ? 8 : 0) | (parts.includes("Alt") ? 1 : 0));
        await this.settle(6000);
        return {};
      }
      if (st.t === "scroll") {
        await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: VIEW_W / 2, y: VIEW_H / 2, deltaX: 0, deltaY: st.dy ?? 400 });
        await new Promise((r) => setTimeout(r, 400));
        return {};
      }
      const label = st.on?.name ? `“${plain(st.on.name, 50)}”` : "that";
      const named = !!(st.on?.sel || st.on?.name);
      const until = Date.now() + Math.max(8000, Math.min(180_000, 2 * (st.ms ?? 0) + 8000));
      type Found = { x: number; y: number; how: string; editable?: boolean; disabled?: boolean; name?: string; at?: string };
      let where: Found | null = null;
      for (;;) {
        where = (await this.page("find", st.on ?? null, named ? undefined : st.x, named ? undefined : st.y)) as Found | null;
        if (where && !where.disabled) break;
        if (Date.now() > until || this.stopRequested()) break;
        this.lastInput = Date.now();
        await new Promise((r) => setTimeout(r, 600));
      }
      // Waited long enough: the place it was is the last way to find it.
      if (!where && named && typeof st.x === "number") where = (await this.page("find", null, st.x, st.y)) as Found | null;
      if (this.stopRequested()) return { failed: "You stopped it." };
      if (!where) return { failed: `I couldn't find ${label} on this page.` };
      if (where.disabled) return { failed: `${label} stayed greyed out, so the page wasn't ready for it.` };
      if (st.t === "click") {
        const stop = personOnly(where.name || st.on?.name) ?? personOnly(where.at);
        if (stop) return { needs: stop };
      }
      // Typing goes only into a box that takes typing: never into whatever happens to be selected.
      if (st.t === "type" && where.editable === false) return { failed: `I found ${label}, but it isn't a box to type in.` };
      if (st.t === "select" && st.v) {
        const ok = await this.page("setSelect", st.on ?? null, st.v);
        if (!ok) return { failed: `I couldn't choose “${tidy(st.v, 40)}” in ${label}.` };
        await this.settle(4000);
        return {};
      }
      await this.clickAt(where.x, where.y);
      await this.popupsDone();
      if (st.t === "type") {
        const v = fillFor(fill, st.blank) ?? (st.v ?? "");
        await new Promise((r) => setTimeout(r, 120));
        // Never into a box that has become a secret one (the page changed since it was recorded).
        const sec = (await this.page("activeSecret")) as boolean | undefined;
        if (sec) return { needs: "The box this step types into is now one for a password, a card or a code. You type it yourself." };
        await this.selectAll();
        if (v) await this.send("Input.insertText", { text: v });
        await new Promise((r) => setTimeout(r, 250));
        return {};
      }
      await this.settle(6000);
      return {};
    } catch (e) {
      return { failed: e instanceof BrowserError ? e.message : "The browser stopped answering." };
    }
  }

  // ---- downloads ----

  /** The browser says a download is starting. Only this person's page counts. */
  private downloadBegins(p: { guid?: string; frameId?: string; url?: string; suggestedFilename?: string } | undefined) {
    const guid = String(p?.guid ?? "");
    const frameId = String(p?.frameId ?? "");
    // Downloads that are long done are let go of; a page can't fill the list for good.
    if (this.dls.size >= 40) for (const [g, x] of this.dls) if (x.done && Date.now() - (x.at ?? 0) > 120_000) this.dls.delete(g);
    if (!guid || this.closed || !this.frames.has(frameId) || this.dls.has(guid) || this.dls.size >= 40) return;
    const url = String(p?.url ?? "");
    const name = safeFileName(p?.suggestedFilename, url);
    const d: { url: string; name: string; frameId: string; done: boolean; at?: number; early?: Promise<{ bytes: Buffer; type: string } | null> } = { url, name, frameId, done: false, at: Date.now() };
    // A file the page built itself is read at once, while the page still has it.
    if (/^blob:/i.test(url)) d.early = this.readBlob(url).catch(() => null);
    else if (/^data:/i.test(url)) { const x = decodeDataUrl(url); d.early = Promise.resolve(x); }
    this.dls.set(guid, d);
    this.lastInput = Date.now();
    this.emit({ type: "file", state: "started", name });
  }
  private downloadEnds(guid: string) {
    const d = this.dls.get(guid);
    if (!d || d.done) return;
    d.done = true;
    const work: Promise<void> = this.saveDownload(guid, d).catch(() => {}).finally(() => { this.dlWork.delete(work); });
    this.dlWork.add(work);
  }
  private fileAsPage(url: string, mime: string) {
    if (!/^https?:/i.test(url) || this.closed) return;
    const key = "page:" + url;
    if (this.dls.has(key)) return;
    let name = "";
    try { name = decodeURIComponent(new URL(url).pathname.split("/").pop() || ""); } catch { /* none */ }
    const ext = /^audio\/(mpeg|mp3)/.test(mime) ? ".mp3" : /^audio\/(wav|x-wav)/.test(mime) ? ".wav" : /pdf/.test(mime) ? ".pdf" : /^video\/mp4/.test(mime) ? ".mp4" : "";
    if (ext && !/\.[a-z0-9]{2,5}$/i.test(name)) name = (name || "download") + ext;
    const d = { url, name: safeFileName(name, url), frameId: this.targetId, done: false, at: Date.now() };
    this.dls.set(key, d);
    // Read once the page has it (it was checked on the way in, like every page) — unless the browser
    // turned out to download it after all (then that download is the file).
    setTimeout(() => {
      if ([...this.dls.entries()].some(([g, x]) => g !== key && x.url === url)) { this.dls.delete(key); return; }
      this.emit({ type: "file", state: "started", name: d.name });
      this.downloadEnds(key);
    }, 1200);
  }
  /** Wait for downloads that started to be saved (a click on Download: the browser says so a moment later). */
  async downloadsSettled(maxMs: number): Promise<void> {
    const until = Date.now() + maxMs;
    await new Promise((r) => setTimeout(r, 700));
    while (Date.now() < until) {
      if (![...this.dls.values()].some((d) => !d.done) && this.dlWork.size === 0) return;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  private async readBlob(url: string): Promise<{ bytes: Buffer; type: string } | null> {
    const id = randomBytes(6).toString("hex");
    const got = (await this.pageWait("grabBlob", 30_000, id, url)) as { ok?: boolean; type?: string; size?: number; len?: number } | undefined;
    if (!got?.ok || !got.len || (got.size ?? 0) > MAX_DOWNLOAD_BYTES) return null;
    let b64 = "";
    for (let at = 0; at < got.len; at += 4_000_000) b64 += String((await this.page("blobPart", id, at, 4_000_000)) ?? "");
    return b64 ? { bytes: Buffer.from(b64, "base64"), type: String(got.type ?? "") } : null;
  }
  /** Fetch an address through the browser itself: its address on the internet, its sign-ins. */
  private async loadResource(frameId: string, url: string): Promise<{ bytes: Buffer; type: string } | null> {
    const r = await this.send<{ resource?: { success?: boolean; httpStatusCode?: number; stream?: string; headers?: Record<string, string> } }>(
      "Network.loadNetworkResource", { frameId, url, options: { disableCache: false, includeCredentials: true } }, 60_000);
    const res = r.resource;
    if (!res?.stream) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      if (!res.success || (res.httpStatusCode && res.httpStatusCode >= 400)) return null;
      for (;;) {
        const c = await this.send<{ data: string; base64Encoded?: boolean; eof?: boolean }>("IO.read", { handle: res.stream, size: 1 << 20 }, 30_000);
        const b = c.base64Encoded ? Buffer.from(c.data || "", "base64") : Buffer.from(c.data || "", "utf8");
        total += b.length;
        if (total > MAX_DOWNLOAD_BYTES) return null;
        chunks.push(b);
        if (c.eof) break;
      }
    } finally {
      try { await this.send("IO.close", { handle: res.stream }); } catch { /* gone */ }
    }
    const type = Object.entries(res.headers ?? {}).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
    return { bytes: Buffer.concat(chunks), type: String(type) };
  }
  private async saveDownload(guid: string, d: { url: string; name: string; frameId: string; early?: Promise<{ bytes: Buffer; type: string } | null> }) {
    let got: { bytes: Buffer; type: string } | null = null;
    if (/^https?:/i.test(d.url) && (await mustRefuse(d.url).catch(() => true))) {
      // From a private or internal address: not read, not even from the browser's own copy.
      this.emit({ type: "file", state: "failed", name: d.name, note: "It came from a private or internal address, so BeeZilla didn't keep it." });
      return;
    }
    if (d.early) got = await d.early;
    else if (/^https?:/i.test(d.url)) got = await this.loadResource(d.frameId, d.url).catch(() => null);
    if (!got && this.provider.savedDownload && !guid.startsWith("page:")) {
      const b = await this.provider.savedDownload(guid).catch(() => null);
      if (b) got = { bytes: b, type: "" };
    }
    if (!got || !got.bytes.length) { this.emit({ type: "file", state: "failed", name: d.name, note: "BeeZilla couldn't read that download." }); return; }
    if (got.bytes.length > MAX_DOWNLOAD_BYTES) { this.emit({ type: "file", state: "failed", name: d.name, note: `It's bigger than ${MAX_DOWNLOAD_BYTES / 1048576} MB, the most the Library keeps.` }); return; }
    const type = safeContentType(got.type, d.name, got.bytes);
    let saved: RunFile | null = null;
    try { saved = this.onFile ? await this.onFile({ name: d.name, type, bytes: got.bytes }) : null; } catch { saved = null; }
    if (!saved) { this.emit({ type: "file", state: "failed", name: d.name, note: "It couldn't be saved to your Library." }); return; }
    this.files.push(saved);
    if (this.files.length > 40) this.files.shift();
    this.lastInput = Date.now();
    this.emit({ type: "file", state: "saved", name: saved.name, url: saved.url, bytes: saved.bytes, fileType: saved.type });
  }

  // ---- ending ----

  async close(reason = "closed"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const t of [this.frameTimer, this.typingTimer, this.scrollTimer, this.navTimer]) if (t) clearTimeout(t);
    this.frameTimer = this.typingTimer = this.scrollTimer = this.navTimer = null;
    for (const off of this.stopHandlers) { try { off(); } catch { /* ignore */ } }
    this.stopHandlers = [];
    this.emit({ type: "ended", reason });
    this.listeners.clear();
    if (this.run) this.run.stop = true;
    try { await this.cdp.send("Page.stopScreencast", {}, this.sid, 3000); } catch { /* going away */ }
    // A browser of your own forgets everything with its context: the sign-ins are kept here, for a while.
    if (this.contextId && this.provider.keepsSignIns && this.provider.kind === "cdp" && !this.forgetOnClose) {
      try {
        const got = await this.cdp.send<{ cookies: unknown[] }>("Storage.getCookies", { browserContextId: this.contextId }, undefined, 3000);
        if (Array.isArray(got.cookies) && got.cookies.length) {
          // Old sign-ins are let go of, and the jar never grows past a couple of thousand people.
          for (const [u, j] of cookieJar) if (Date.now() - j.at > JAR_HOURS * 3600_000) cookieJar.delete(u);
          if (cookieJar.size >= 2000) cookieJar.delete(cookieJar.keys().next().value as string);
          cookieJar.set(this.userId, { cookies: got.cookies.slice(0, 400), at: Date.now() });
        }
      } catch { /* nothing kept */ }
    }
    if (this.targetId) { try { await this.cdp.send("Target.closeTarget", { targetId: this.targetId }, undefined, 3000); } catch { /* going away */ } }
    if (this.contextId) { try { await this.cdp.send("Target.disposeBrowserContext", { browserContextId: this.contextId }, undefined, 3000); } catch { /* it goes with the connection */ } }
    this.cdp.close();
    try { await this.provider.close(); } catch { /* it times out on its own */ }
    this.bill(true);
    try { this.onClosed?.({ seconds: Math.max(1, Math.round((Date.now() - this.startedAt) / 1000)), reason }); } catch { /* accounting never blocks */ }
  }
}

// ── All the sessions ───────────────────────────────────────────────────────

const sessions = new Map<string, BrowserSession>();
const byUser = new Map<string, string>();
let reaper: ReturnType<typeof setInterval> | null = null;

function startReaper() {
  if (reaper) return;
  reaper = setInterval(() => {
    const now = Date.now();
    for (const s of [...sessions.values()]) {
      if (now - s.startedAt > s.maxMs) void dropSession(s, "time").catch(() => {});
      // A job going on is not idle, however long the model takes to think (it has its own limits).
      else if (now - s.lastInput > idleSeconds() * 1000 && !s.busy()) void dropSession(s, "idle").catch(() => {});
      else s.bill();
    }
    if (!sessions.size && reaper) { clearInterval(reaper); reaper = null; }
  }, 10_000);
  (reaper as { unref?: () => void }).unref?.();
}

async function dropSession(s: BrowserSession, reason: string) {
  sessions.delete(s.id);
  if (byUser.get(s.userId) === s.id) byUser.delete(s.userId);
  await s.close(reason);
}

export function openSessionCount(): number { return sessions.size; }

const opening = new Set<string>();
const maxSessions = () => { const n = Number(env("BZ_BROWSER_MAX_SESSIONS")); return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 20; };

/**
 * Open a browser for this person. Any browser they already had open is closed first; they can
 * not have two opening at once, and the whole server holds only so many (each costs money).
 */
export async function openBrowserSession(
  userId: string,
  opts: { startUrl?: string; steps?: unknown; maxSeconds?: number; onBill?: BrowserSession["onBill"]; onClosed?: BrowserSession["onClosed"] } = {},
): Promise<BrowserSession> {
  // Taken before anything waits, so parallel requests can't each open their own.
  if (opening.has(userId)) throw new BrowserError("busy", "A browser is already opening for you. Give it a moment.");
  opening.add(userId);
  try {
    const before = byUser.get(userId);
    if (before) { const old = sessions.get(before); if (old) await dropSession(old, "replaced"); }
    if (sessions.size >= maxSessions()) throw new BrowserError("busy", "BeeZilla's browsers are all in use right now. Try again in a minute.");
    const provider = await openProvider(userId);
    let cdp: CdpConnection;
    try {
      cdp = await CdpConnection.connect(provider.wsUrl);
    } catch {
      await provider.close().catch(() => {});
      throw new BrowserError("start_failed", "BeeZilla opened a browser but couldn't connect to it. Try again.");
    }
    const session = new BrowserSession(userId, cdp, provider);
    if (opts.maxSeconds && opts.maxSeconds > 0) session.maxMs = Math.min(session.maxMs, opts.maxSeconds * 1000);
    session.onBill = opts.onBill;
    session.onClosed = opts.onClosed;
    sessions.set(session.id, session);
    byUser.set(userId, session.id);
    startReaper();
    try {
      await session.begin(opts.startUrl ? cleanUrl(opts.startUrl, 2000) || undefined : undefined);
    } catch (e) {
      await dropSession(session, "start failed");
      throw e instanceof BrowserError ? e : new BrowserError("start_failed", "The browser opened but wouldn't start. Try again.");
    }
    if (opts.steps) session.loadSteps(opts.steps);
    return session;
  } finally {
    opening.delete(userId);
  }
}

/** A person's own browser session, or null (never someone else's). */
export function getBrowserSession(id: string, userId: string): BrowserSession | null {
  const s = sessions.get(String(id));
  return s && s.userId === userId && !s.closed ? s : null;
}
export function currentBrowserSession(userId: string): BrowserSession | null {
  const id = byUser.get(userId);
  return id ? getBrowserSession(id, userId) : null;
}
export async function closeBrowserSession(id: string, userId: string, reason = "closed"): Promise<boolean> {
  const s = getBrowserSession(id, userId);
  if (!s) return false;
  await dropSession(s, reason);
  return true;
}
/** For shutdown and tests: close everything. */
export async function closeAllBrowserSessions(): Promise<void> {
  await Promise.all([...sessions.values()].map((s) => dropSession(s, "shutdown")));
}

