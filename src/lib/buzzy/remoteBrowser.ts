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
import { randomBytes } from "node:crypto";
import { promises as dnsPromises } from "node:dns";
import { isIP } from "node:net";
import { CdpConnection } from "./cdp";
import { isPrivateIp } from "./website";
import { MAX_STEPS, cleanSteps, cleanUrl, isRecordedKey, plain, tidy, type BrowserStep, type ElementHint } from "./boardNodes";

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
  constructor(readonly code: "not_configured" | "start_failed" | "gone" | "busy" | "bad_request", message: string) {
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

async function openHyperbrowser(): Promise<ProviderHandle> {
  const key = env("BZ_HYPERBROWSER_KEY");
  const headers = { "content-type": "application/json", "x-api-key": key };
  let res: Response;
  try {
    // No proxy: the session goes out from the provider's data-centre address, the same as
    // the page reader the AI already uses (browser.ts). That is the point of this browser.
    res = await fetch(`${hbBase()}/session`, { method: "POST", headers, body: JSON.stringify({ useProxy: false }), signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new BrowserError("start_failed", "BeeZilla couldn't reach the browser service. Try again in a moment.");
  }
  if (!res.ok) throw new BrowserError("start_failed", `The browser service said no (${res.status}). Try again in a moment.`);
  let j: Record<string, unknown>;
  try { j = (await res.json()) as Record<string, unknown>; } catch { j = {}; }
  const id = String(j.id ?? j.sessionId ?? "");
  const ws = String(j.wsEndpoint ?? j.ws_endpoint ?? j.websocketUrl ?? "");
  if (!id || !/^wss?:\/\//i.test(ws)) throw new BrowserError("start_failed", "The browser service answered in a way BeeZilla didn't expect.");
  return {
    kind: "hyperbrowser",
    label: "A cloud browser on a server",
    wsUrl: ws,
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
  return { kind: "cdp", label: "A browser on a server", wsUrl: ws, close: async () => {} };
}

async function openProvider(): Promise<ProviderHandle> {
  const kind = providerKind();
  if (kind === "hyperbrowser") return openHyperbrowser();
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
  var SECRET = /pass(word|code|wort)?|pwd|contrase|mot.?de.?passe|senha|secret|token|otp|totp|one.?time|2fa|mfa|verification|security.?code|\bpin\b|cvv|cvc|card.?(number|no|num)|cc.?(num|csc|exp)|ssn|social.?sec/i;
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
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), how: how, name: nameOf(el), editable: describe(el).editable };
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
  return { describeAt: describeAt, arm: arm, value: value, options: options, find: find, pick: pick, setSelect: setSelect, selectActive: selectActive, look: look, readText: readText, ready: ready, nav: nav, go: go };
})()`;

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

// ── A session ──────────────────────────────────────────────────────────────

export type SessionEvent =
  | { type: "hello"; id: string; view: { w: number; h: number }; recording: boolean; steps: BrowserStep[]; url: string; title: string; where: Where | null; replaying: boolean; canBack: boolean; canForward: boolean; maxSeconds: number; idleSeconds: number; label: string }
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
  | { type: "ended"; reason: string };

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
      this.sid = (await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true })).sessionId;
      // A link that opens a new window opens in this one: the person sees one page.
      try {
        await cdp.send("Target.setDiscoverTargets", { discover: true });
        this.stopHandlers.push(cdp.on("Target.targetCreated", (p) => void this.onNewTarget(p?.targetInfo)));
      } catch { /* optional */ }
      try { await cdp.send("Browser.setDownloadBehavior", { behavior: "deny", ...(this.contextId ? { browserContextId: this.contextId } : {}) }); } catch { /* optional */ }
    }
    const s = this.sid;
    await cdp.send("Page.enable", {}, s);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1, mobile: false }, s);
    try {
      await cdp.send("Network.enable", {}, s);
      await cdp.send("Network.setBlockedURLs", { urls: ["file://*", "ftp://*", "chrome://*", "chrome-extension://*", "view-source:*"] }, s);
    } catch { /* optional */ }
    this.stopHandlers.push(
      cdp.on("Page.screencastFrame", (p, sid) => {
        if (sid !== this.sid) return;
        void cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }, this.sid).catch(() => {});
        this.takeFrame(String(p.data || ""), Number(p.metadata?.deviceWidth) || VIEW_W, Number(p.metadata?.deviceHeight) || VIEW_H);
      }),
      // A new page is a new world for the helpers (below).
      cdp.on("Page.frameNavigated", (p, sid) => { if (sid === this.sid && !p?.frame?.parentId) { this.world = null; this.lookSoon(); } }),
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
    if (this.closed || this.replaying) return;
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

  /** Play steps in this browser, the way a person would, and say how far it got. */
  async replay(raw: unknown): Promise<void> {
    if (this.closed || this.replaying) return;
    const steps = cleanSteps(raw);
    if (!steps.length) { this.emit({ type: "notice", text: "There's nothing recorded to play yet." }); return; }
    // Marked at once, before anything waits: a second request can't start a second play.
    this.replaying = true;
    this.lastInput = Date.now();
    await this.queue(() => this.flushAll());
    await this.setRecording(false);
    const done = (ok: boolean, note: string, failedAt?: number, ran = 0) => {
      this.replaying = false;
      return this.finishReplay(ok, note, failedAt, ran);
    };
    try {
      let skipped = 0;
      for (let i = 0; i < steps.length; i++) {
        if (this.closed) return;
        const st = steps[i]!;
        this.lastInput = Date.now();
        this.emit({ type: "replay", i, state: "running" });
        if (st.secret && st.t === "type") {
          skipped++;
          this.emit({ type: "replay", i, state: "skipped", note: "You enter this yourself — it was never recorded." });
          continue;
        }
        const failed = await this.play(st);
        if (failed) {
          this.emit({ type: "replay", i, state: "failed", note: failed });
          await done(false, failed, i, i);
          return;
        }
        this.emit({ type: "replay", i, state: "ok" });
      }
      await done(true, skipped ? `Played every step. ${skipped} ${skipped === 1 ? "step was" : "steps were"} left for you (passwords and codes are never recorded).` : "Played every step.", undefined, steps.length);
    } catch (e) {
      await done(false, "The browser stopped answering.", undefined, 0);
      void e;
    }
  }
  private async finishReplay(ok: boolean, note: string, failedAt: number | undefined, ran: number) {
    let text = "";
    try {
      await this.look();
      text = plain(await this.page("readText"), 700);
    } catch { /* the page is gone: say what we know */ }
    this.emit({ type: "replay-done", ok, failedAt, note, steps: ran, finalUrl: this.url, title: plain(this.title, 140), text });
    this.lookSoon();
  }

  /** One step. Returns why it could not be done, or "" when it was. */
  private async play(st: BrowserStep): Promise<string> {
    try {
      if (st.t === "goto" && st.url) {
        await this.navigateRaw(st.url);
        await this.settle(9000);
        return "";
      }
      if (st.t === "back") {
        await this.history("back");
        await this.settle(6000);
        return "";
      }
      if (st.t === "key" && st.key) {
        const parts = st.key.split("+");
        const key = parts[parts.length - 1]!;
        if (!isRecordedKey(key)) return `I can't press ${tidy(st.key, 20)}.`;
        const modifiers = (parts.includes("Shift") ? 8 : 0) | (parts.includes("Alt") ? 1 : 0);
        await this.send("Input.dispatchKeyEvent", { type: key === "Enter" ? "keyDown" : "rawKeyDown", key, windowsVirtualKeyCode: keyCodeFor(key), modifiers, text: key === "Enter" ? "\r" : undefined });
        await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: keyCodeFor(key), modifiers });
        await this.settle(6000);
        return "";
      }
      if (st.t === "scroll") {
        await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: VIEW_W / 2, y: VIEW_H / 2, deltaX: 0, deltaY: st.dy ?? 400 });
        await new Promise((r) => setTimeout(r, 400));
        return "";
      }
      const where = (await this.page("find", st.on ?? null, st.x, st.y)) as { x: number; y: number; how: string; editable?: boolean } | null;
      const label = st.on?.name ? `“${plain(st.on.name, 50)}”` : "that";
      if (!where) return `I couldn't find ${label} on this page.`;
      // Typing goes only into a box that takes typing: never into whatever happens to be selected.
      if (st.t === "type" && where.editable === false) return `I found ${label}, but it isn't a box to type in.`;
      if (st.t === "select" && st.v) {
        const ok = await this.page("setSelect", st.on ?? null, st.v);
        if (!ok) return `I couldn't choose “${tidy(st.v, 40)}” in ${label}.`;
        await this.settle(4000);
        return "";
      }
      await this.clickAt(where.x, where.y);
      await this.popupsDone();
      if (st.t === "type") {
        await this.page("selectActive");
        if (st.v) await this.send("Input.insertText", { text: st.v });
        await new Promise((r) => setTimeout(r, 250));
        return "";
      }
      await this.settle(6000);
      return "";
    } catch (e) {
      return e instanceof BrowserError ? e.message : "The browser stopped answering.";
    }
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
    try { await this.cdp.send("Page.stopScreencast", {}, this.sid, 3000); } catch { /* going away */ }
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
      else if (now - s.lastInput > idleSeconds() * 1000) void dropSession(s, "idle").catch(() => {});
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
    const provider = await openProvider();
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

