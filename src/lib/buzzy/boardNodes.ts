/**
 * The two nodes under "More" on the Idea Board: API use and Browser use.
 *
 * Owner, 2026-11-21: "you should be able to add a node and connect nodes. But add a node
 * under more for API use and add another one for browser use. And you should be able to
 * record yourself using the browser in order to accomplish the task at hand. But the
 * browser it pulls up should be via a non-residential IP, so you can see it as the AI
 * would see it."
 *
 * A node is an ordinary board card (kind "api" or "browser") whose details travel in one
 * text field, `node`, that holds JSON. The board saves it with the card, so a node moves
 * with the board to any computer, shows in History, copies with Duplicate and lines run
 * to it like any other card. This file is what the ACCOUNT keeps of that JSON
 * (whiteboards.ts calls cleanNodeText): the shape is checked, every text is capped, and
 * nothing secret is kept.
 *
 * What is never kept, on purpose — a board is saved to the account, can be copied into a
 * recipe and can be shared as a page:
 *   - the value of a key, token, password or cookie (an API node keeps the NAME of the key
 *     it needs, never the value; the value is typed again for each test);
 *   - the value of a secret query word (?api_key=…) in an address;
 *   - what was typed into a password, card-number or one-time-code field in a recording.
 */

export const NODE_KINDS = ["api", "browser"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
export const isNodeKind = (k: unknown): k is NodeKind => k === "api" || k === "browser";

/** One node's JSON, as text. A recording of 150 steps is about 40 KB. */
export const NODE_TEXT_MAX = 60_000;
export const API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type ApiMethod = (typeof API_METHODS)[number];
export const MAX_HEADERS = 12;
export const MAX_KEYS = 6;
export const MAX_STEPS = 150;

/**
 * Names that carry a secret. Matches whole words in header names, query words, body keys and
 * field names: "Authorization", "x-api-key", "api_key", "accessToken", "Cookie", "password"…
 * A name written in camelCase is split into words first, so "clientSecret" and "AccessKey" count.
 * A service's own odd name for a key ("X-Honeycomb-Team") can't be known: the window says to
 * put every key in Keys.
 */
const SECRET_WORDS = "authorization|authentication|auth|cookie|set-cookie|token|secret|password|passwd|pwd|passcode|pass|pin|api[-_ ]?key|apikey|hapikey|access[-_ ]?key|key|sig|signature|bearer|credentials?|session|session[-_ ]?id|sessionid|csrf|xsrf|private|jwt|otp|refresh|client[-_ ]?secret";
const SECRET_NAME = new RegExp(`(^|[-_. ])(${SECRET_WORDS})([-_. ]|$)`, "i");
// For the value of a word in an address or a body only the plain ones: "key", "private", "refresh",
// "pin" and "pass" are also what a JSON body calls a project key, a flag, a toggle or a page number.
const SECRET_VALUE_WORDS = "authorization|authentication|auth|cookie|token|secret|password|passwd|pwd|passcode|api[-_ ]?key|apikey|hapikey|access[-_ ]?key|sig|signature|bearer|credentials?|session[-_ ]?id|sessionid|csrf|xsrf|jwt|client[-_ ]?secret";
const SECRET_VALUE_NAME = new RegExp(`(^|[-_. ])(${SECRET_VALUE_WORDS})([-_. ]|$)`, "i");
// Not keys, whatever the word: a page of results, a header that makes a retry safe.
const NOT_SECRET = /(page|next|prev|previous|cursor|continuation|sync|idempotency)[-_. ]?(token|key)/i;
const words = (name: unknown) => String(name ?? "").replace(/([a-z0-9])([A-Z])/g, "$1-$2");
/** A header's or a key's own name: "Authorization", "x-api-key", "accessToken", "Cookie", "password"… (camelCase is split first). */
export function isSecretName(name: unknown): boolean {
  const w = words(name);
  return !NOT_SECRET.test(w) && SECRET_NAME.test(w);
}
/** A word in an address or in a request body whose value is a secret: the plain ones only. */
export function isSecretValueName(name: unknown): boolean {
  const w = words(name);
  return !NOT_SECRET.test(w) && SECRET_VALUE_NAME.test(w);
}
/**
 * A word in an address: the plain ones, and "key" on its own (?key=… is how many services take
 * theirs). In a body "key" is more often a project or record key, so there it stays.
 */
export function isSecretQueryName(name: unknown): boolean {
  return isSecretValueName(name) || /^key$/i.test(String(name ?? "").trim());
}

/**
 * A field a person types a secret into: never recorded. Matches what the field says about
 * itself (its label, placeholder, id, name) in English and a few other languages.
 */
export const SECRET_FIELD = /pass(word|code|wort)?|pwd|contrase|mot.?de.?passe|senha|secret|token|otp|totp|one.?time|2fa|mfa|verification|security.?code|\bcode\b|\bcard\b|\bpin\b|cvv|cvc|card.?(number|no|num)|cc.?(num|csc|exp)|iban|account.?(no|num)|routing|ssn|social.?sec/i;

/**
 * Text from outside (a page, an API, a person): no control characters, no run of spaces,
 * capped, and none of the characters that reorder or hide text.
 */
export function tidy(v: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex -- deliberate: strips control bytes
  const s = String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\u200b\u2060-\u2064\u202a-\u202e\u2066-\u2069\ufeff]/g, "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).replace(/[\uD800-\uDBFF]$/, "") + "…";
}
/**
 * A page's own words (a button's name, a box's label, what a page said) before BeeZilla is told
 * them between “ ” marks: the curly quotes are taken out, or a page's own mark would close the
 * quote early and what follows it would read as the owner's.
 */
export function plain(v: unknown, max: number): string {
  return tidy(String(v ?? "").replace(/[\u201c\u201d\u201e\u201f]/g, ""), max);
}
/** Like tidy but keeps line breaks (a request body, a pasted answer). */
export function block(v: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex -- deliberate: strips control bytes except \n and \t
  const s = String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max);
  return s.replace(/[\uD800-\uDBFF]$/, "");
}
const isoOrEmpty = (v: unknown): string => {
  const s = String(v ?? "");
  return /^\d{4}-\d\d-\d\dT[\d:.]+Z?$/.test(s) ? s.slice(0, 30) : "";
};
const num = (v: unknown, lo: number, hi: number): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : undefined;
};

/** A web address a node may hold: http or https, no user:password, no fragment. "" if not. */
export function cleanUrl(v: unknown, max = 2048): string {
  const s = String(v ?? "").trim();
  if (!s || s.length > max) return "";
  let u: URL;
  try { u = new URL(s); } catch { return ""; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  if (u.username || u.password) return "";
  u.hash = "";
  return u.toString();
}

/** A web address kept on a node: cleanUrl, and no secret query word keeps its value. */
export function cleanUrlNoSecrets(v: unknown, max = 2048): string {
  const u = cleanUrl(v, max);
  return u ? stripSecretQuery(u).url : "";
}

/**
 * An address with the values of secret query words taken out (?api_key=abc → ?api_key=).
 * `found` names the words so the node can ask for them again as keys.
 */
export function stripSecretQuery(url: string): { url: string; found: string[] } {
  let u: URL;
  try { u = new URL(url); } catch { return { url, found: [] }; }
  if (u.search.length < 2) return { url, found: [] };
  const r = emptySecretPairs(u.search.slice(1));
  if (!r.found.length) return { url, found: [] };
  u.search = "?" + r.query;
  return { url: u.toString(), found: r.found };
}

/**
 * The query text itself (a=1&token=abc), pair by pair, with the value of each secret-named word
 * emptied. Going through URLSearchParams would re-write the other words ("%20" becomes "+"), and
 * a few services treat that differently.
 */
function emptySecretPairs(query: string): { query: string; found: string[] } {
  const found: string[] = [];
  const pairs = query.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    const rawName = eq < 0 ? pair : pair.slice(0, eq);
    const rawValue = eq < 0 ? "" : pair.slice(eq + 1);
    let name = rawName;
    try { name = decodeURIComponent(rawName.replace(/\+/g, " ")); } catch { /* keep it as written */ }
    if (!isSecretQueryName(name) || rawValue === "") return pair;
    found.push(name.slice(0, 60));
    return rawName + "=";
  });
  return { query: pairs.join("&"), found: [...new Set(found)] };
}

/** A link as a page wrote it — a full address or just a path — without the value of any secret word in it. */
function cleanHref(v: unknown): string {
  let raw = tidy(v, 300).replace(/\s/g, "");
  // A token can ride in the fragment as well (…/callback#access_token=…).
  const h = raw.indexOf("#");
  if (h >= 0 && raw.indexOf("=", h) > 0) raw = raw.slice(0, h + 1) + emptySecretPairs(raw.slice(h + 1)).query;
  const q = raw.indexOf("?");
  if (q < 0) return raw;
  const hash = raw.indexOf("#", q);
  const query = raw.slice(q + 1, hash < 0 ? undefined : hash);
  return raw.slice(0, q + 1) + emptySecretPairs(query).query + (hash < 0 ? "" : raw.slice(hash));
}

// ── API use ────────────────────────────────────────────────────────────────

export interface ApiLast {
  at: string;
  /** The address answered (any status). false: it could not be reached. */
  reached: boolean;
  status?: number;
  statusText?: string;
  ms?: number;
  type?: string;
  bytes?: number;
  preview?: string;
  error?: string;
}
export interface ApiSpec {
  v: 1;
  /** What the person wants from it, in their words. */
  purpose: string;
  method: ApiMethod;
  url: string;
  headers: { name: string; value: string }[];
  /** The keys it needs: names only. `in` says where each one goes when the call is made. */
  keys: { name: string; in: "header" | "query" }[];
  body: string;
  last?: ApiLast;
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,60}$/;

/**
 * A request body with every secret-named value emptied. A JSON body is walked key by key; a
 * form body (a=1&password=x) pair by pair. Keys can only be kept as a header or an address
 * word, so one in a body is left out rather than saved (it is typed again for each try).
 */
export function scrubBody(text: string): string {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      let changed = false;
      const walk = (v: unknown, depth: number): unknown => {
        if (depth > 12) return v;
        if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
        if (v && typeof v === "object") {
          const o: Record<string, unknown> = {};
          for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
            if (isSecretValueName(k) && x !== "" && x !== null && typeof x !== "object") { o[k] = ""; changed = true; } else o[k] = walk(x, depth + 1);
          }
          return o;
        }
        return v;
      };
      const out = walk(JSON.parse(t), 0);
      return changed ? JSON.stringify(out, null, 2) : text;
    } catch { /* not JSON: look at it as a form */ }
  }
  if (/^[^\s=&]+=/.test(t)) {
    let changed = false;
    const parts = t.split("&").map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return pair;
      let name = pair.slice(0, eq);
      try { name = decodeURIComponent(name.replace(/\+/g, " ")); } catch { /* as written */ }
      if (!isSecretValueName(name) || pair.slice(eq + 1) === "") return pair;
      changed = true;
      return pair.slice(0, eq + 1);
    });
    return changed ? parts.join("&") : text;
  }
  return text;
}

export function cleanApiSpec(raw: unknown): ApiSpec {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const method = API_METHODS.includes(String(r.method).toUpperCase() as ApiMethod) ? (String(r.method).toUpperCase() as ApiMethod) : "GET";

  const keys: ApiSpec["keys"] = [];
  const addKey = (name: unknown, where: unknown) => {
    const n = tidy(name, 60);
    if (!n || keys.length >= MAX_KEYS || keys.some((k) => k.name.toLowerCase() === n.toLowerCase())) return;
    keys.push({ name: n, in: where === "query" ? "query" : "header" });
  };
  for (const k of Array.isArray(r.keys) ? r.keys : []) {
    const o = (k ?? {}) as Record<string, unknown>;
    addKey(o.name, o.in);
  }

  const headers: ApiSpec["headers"] = [];
  for (const h of Array.isArray(r.headers) ? r.headers : []) {
    const o = (h ?? {}) as Record<string, unknown>;
    const name = String(o.name ?? "").trim();
    if (!HEADER_NAME.test(name) || headers.length >= MAX_HEADERS) continue;
    if (headers.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
    // A secret header keeps its name only; the person types the value for each test.
    if (isSecretName(name) || o.secret === true) { addKey(name, "header"); continue; }
    headers.push({ name, value: tidy(o.value, 400) });
  }

  let url = cleanUrl(r.url);
  if (url) {
    const s = stripSecretQuery(url);
    url = s.url;
    s.found.forEach((w) => addKey(w, "query"));
  }

  const spec: ApiSpec = {
    v: 1,
    purpose: tidy(r.purpose, 300),
    method,
    url,
    headers,
    keys,
    body: method === "GET" ? "" : scrubBody(block(r.body, 6000)),
  };
  const l = r.last as Record<string, unknown> | undefined;
  if (l && typeof l === "object") {
    const last: ApiLast = { at: isoOrEmpty(l.at), reached: l.reached === true };
    const status = num(l.status, 0, 999);
    if (status) last.status = status;
    if (l.statusText) last.statusText = tidy(l.statusText, 60);
    const ms = num(l.ms, 0, 600_000);
    if (ms !== undefined) last.ms = ms;
    if (l.type) last.type = tidy(l.type, 80);
    const bytes = num(l.bytes, 0, 1e9);
    if (bytes !== undefined) last.bytes = bytes;
    if (l.preview) last.preview = block(l.preview, 1500);
    if (l.error) last.error = tidy(l.error, 200);
    if (last.at) spec.last = last;
  }
  return spec;
}

// ── Browser use ────────────────────────────────────────────────────────────

export const STEP_TYPES = ["goto", "click", "type", "key", "scroll", "select", "back"] as const;
export type StepType = (typeof STEP_TYPES)[number];

/** How to find the same thing on the page again. */
export interface ElementHint {
  tag?: string;
  role?: string;
  /** What a person would call it: its label or its words. */
  name?: string;
  /** A CSS selector that found it when it was recorded. */
  sel?: string;
  type?: string;
  placeholder?: string;
  href?: string;
  /** The box's own `autocomplete` word ("cc-number", "one-time-code", "current-password"…). */
  ac?: string;
}
export interface BrowserStep {
  t: StepType;
  /** In plain words, WITHOUT any typed text ("Type into “Email”"). */
  say: string;
  /** The page it happened on. */
  url?: string;
  on?: ElementHint;
  /** What was typed or chosen. Absent for a secret. */
  v?: string;
  secret?: boolean;
  key?: string;
  dy?: number;
  /** Where the click landed in the 1280×800 window: the last way to find it. */
  x?: number;
  y?: number;
  /** The pause before this step, in milliseconds. */
  ms?: number;
}
export interface BrowserRun {
  at: string;
  ok: boolean;
  steps: number;
  failedAt?: number;
  note?: string;
  finalUrl?: string;
  title?: string;
  text?: string;
}
export interface BrowserSpec {
  v: 1;
  purpose: string;
  startUrl: string;
  steps: BrowserStep[];
  recordedAt?: string;
  /** Where the recording browser ran, as it saw itself. */
  where?: { label: string; ip?: string; org?: string; kind?: "datacenter" | "home" | "unknown" };
  lastRun?: BrowserRun;
}

/** The keys that count as a step on their own. Letters and editing keys are the typing. */
const KEYS_RECORDED = new Set(["Enter", "Tab", "Escape"]);
export const isRecordedKey = (k: string) => KEYS_RECORDED.has(k);

function cleanHint(raw: unknown): ElementHint | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const h: ElementHint = {};
  if (o.tag) h.tag = tidy(o.tag, 20).toLowerCase();
  if (o.role) h.role = tidy(o.role, 30).toLowerCase();
  if (o.name) h.name = plain(o.name, 90);
  if (o.sel) h.sel = tidy(o.sel, 240);
  if (o.type) h.type = tidy(o.type, 20).toLowerCase();
  if (o.placeholder) h.placeholder = plain(o.placeholder, 90);
  if (o.href) h.href = cleanHref(o.href);
  if (o.ac) h.ac = tidy(o.ac, 40).toLowerCase();
  return Object.keys(h).length ? h : undefined;
}

export function cleanStep(raw: unknown): BrowserStep | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const t = String(o.t) as StepType;
  if (!(STEP_TYPES as readonly string[]).includes(t)) return null;
  const step: BrowserStep = { t, say: tidy(o.say, 160) || t };
  const url = o.url === "about:blank" ? "about:blank" : cleanUrlNoSecrets(o.url, 300);
  if (url) step.url = url;
  const on = cleanHint(o.on);
  if (on) step.on = on;
  // A box that says it is for a password, a code or a card is a secret one, whatever the page
  // reported about it: nothing typed into it is kept.
  const looksSecret = !!on && (on.type === "password" || /one-time-code|cc-|current-password|new-password/.test(on.ac ?? "") || SECRET_FIELD.test([on.name, on.placeholder, on.sel, on.ac].filter(Boolean).join(" ")));
  const secret = o.secret === true || (t === "type" && looksSecret);
  if (secret) step.secret = true;
  else if (o.v != null && o.v !== "") step.v = tidy(o.v, 400);
  if (t === "key") step.key = tidy(o.key, 20);
  const dy = num(o.dy, -20_000, 20_000);
  if (t === "scroll" && dy !== undefined) step.dy = dy;
  const x = num(o.x, 0, 4000);
  const y = num(o.y, 0, 4000);
  if (x !== undefined && y !== undefined && (t === "click" || t === "type" || t === "select")) { step.x = x; step.y = y; }
  const ms = num(o.ms, 0, 30_000);
  if (ms) step.ms = ms;
  return step;
}

export function cleanSteps(raw: unknown): BrowserStep[] {
  const out: BrowserStep[] = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    const c = cleanStep(s);
    if (c) out.push(c);
    if (out.length >= MAX_STEPS) break;
  }
  return out;
}

export function cleanBrowserSpec(raw: unknown): BrowserSpec {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const spec: BrowserSpec = {
    v: 1,
    purpose: tidy(r.purpose, 300),
    startUrl: cleanUrlNoSecrets(r.startUrl, 600),
    steps: cleanSteps(r.steps),
  };
  const at = isoOrEmpty(r.recordedAt);
  if (at) spec.recordedAt = at;
  const w = r.where as Record<string, unknown> | undefined;
  if (w && typeof w === "object" && w.label) {
    spec.where = { label: tidy(w.label, 120) };
    if (w.ip && /^[0-9a-fA-F:.]{3,45}$/.test(String(w.ip))) spec.where.ip = String(w.ip);
    if (w.org) spec.where.org = tidy(w.org, 100);
    if (w.kind === "datacenter" || w.kind === "home" || w.kind === "unknown") spec.where.kind = w.kind;
  }
  const l = r.lastRun as Record<string, unknown> | undefined;
  if (l && typeof l === "object" && isoOrEmpty(l.at)) {
    const run: BrowserRun = { at: isoOrEmpty(l.at), ok: l.ok === true, steps: num(l.steps, 0, MAX_STEPS) ?? 0 };
    const failedAt = num(l.failedAt, 0, MAX_STEPS);
    if (failedAt !== undefined) run.failedAt = failedAt;
    if (l.note) run.note = tidy(l.note, 200);
    const fu = cleanUrlNoSecrets(l.finalUrl, 300);
    if (fu) run.finalUrl = fu;
    if (l.title) run.title = plain(l.title, 140);
    if (l.text) run.text = plain(l.text, 700);
    spec.lastRun = run;
  }
  return spec;
}

/**
 * What the account keeps of a node's `node` text. "" when the text is not valid for that
 * kind of card (the card keeps its title and words; the node details are dropped).
 */
export function cleanNodeText(kind: unknown, text: unknown): string {
  if (!isNodeKind(kind)) return "";
  const s = String(text ?? "");
  if (!s || s.length > NODE_TEXT_MAX) return "";
  let parsed: unknown;
  try { parsed = JSON.parse(s); } catch { return ""; }
  const clean = kind === "api" ? cleanApiSpec(parsed) : cleanBrowserSpec(parsed);
  const out = JSON.stringify(clean);
  return out.length > NODE_TEXT_MAX ? "" : out;
}

/**
 * What a node card says in its own `body` — shown on the card, kept with the board, used by a
 * recipe or a shared page — computed here from the cleaned node, so a page can't put anything
 * else there. whiteboard.js `nodeBody` writes the same text; test-board-nodes.ts holds them equal.
 */
export function bodyFor(kind: unknown, spec: ApiSpec | BrowserSpec): string {
  const lead = spec.purpose ? tidy(spec.purpose, 300) + "\n" : "";
  if (kind === "api") {
    const a = spec as ApiSpec;
    return (lead + (a.url ? `${a.method || "GET"} ${a.url}` : "")).slice(0, 700);
  }
  const steps = (spec as BrowserSpec).steps || [];
  if (!steps.length) return tidy(spec.purpose, 300);
  return (lead + steps.slice(0, 12).map((x, i) => `${i + 1}. ${tidy(x.say, 90)}`).join("\n") + (steps.length > 12 ? `\n… and ${steps.length - 12} more steps` : "")).slice(0, 1200);
}
