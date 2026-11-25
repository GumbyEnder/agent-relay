/**
 * "Try it" for an API node: make the call the node describes, from this server, and
 * hand back what came back.
 *
 * This server is what the AI calls from too, so the answer is the one BeeZilla would get
 * (a person's own computer can differ: another address, another network, another
 * country). The call is the person's own request, made on their say-so with the Try it
 * button, never a model's.
 *
 * It can be pointed at anything the person types, so it is guarded like every other
 * reader here:
 *   - http and https only, and only a few ports (80, 443 and the usual API ones);
 *   - the address is resolved HERE and the connection is made to the address that was
 *     checked, never to a second lookup (a private name that answers a public address
 *     once and a private one next is the classic way around a check);
 *   - private, loopback, link-local and cloud-metadata addresses are refused, on every
 *     redirect too; a redirect to another site drops the keys that were sent;
 *   - 12 seconds, 512 KB read, 3 redirects, GET and HEAD only follow them;
 *   - a key's value is used for this call and forgotten; it is also taken out of the
 *     answer if the service echoes it back.
 *
 * BZ_API_NODE_ALLOW_PRIVATE=1 lifts the private-address rule for a development or test
 * server (the test suites call a server on 127.0.0.1). Never set it on a deployment.
 */
import { request as httpsRequest } from "node:https";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { promises as dnsPromises } from "node:dns";
import { isIP } from "node:net";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { isPrivateIp } from "./website";
import { API_METHODS, isSecretName, cleanUrl, tidy, block, type ApiMethod } from "./boardNodes";

export const API_CALL_TIMEOUT_MS = 12_000;
export const API_CALL_MAX_BYTES = 512 * 1024;
export const API_CALL_MAX_REDIRECTS = 3;
export const API_PREVIEW_CHARS = 6000;
const PORTS = new Set([80, 443, 3000, 5000, 8000, 8080, 8443, 8888]);

export interface ApiCallInput {
  method?: unknown;
  url?: unknown;
  headers?: unknown;
  /** Secrets for this call only: { name, in: "header" | "query", value }. */
  keys?: unknown;
  body?: unknown;
}

export type ApiCallResult =
  | {
      ok: true;
      reached: true;
      at: string;
      status: number;
      statusText: string;
      ms: number;
      type: string;
      bytes: number;
      preview: string;
      truncated: boolean;
      /** A few response headers worth showing (type, size, limits). */
      headers: [string, string][];
      finalUrl: string;
      redirects: number;
    }
  | { ok: false; reached: false; at: string; ms: number; code: "bad_url" | "blocked" | "timeout" | "network" | "bad_request"; error: string };

class CallError extends Error {
  constructor(readonly code: "bad_url" | "blocked" | "timeout" | "network" | "bad_request", message: string) {
    super(message);
  }
}

const allowPrivateNow = () => (process.env.BZ_API_NODE_ALLOW_PRIVATE ?? "").trim() === "1";

// Names are looked up with a resolver of our own that gives up after 3 seconds. The system's
// lookup (getaddrinfo) runs on the four threads every file, crypto and zlib job in this
// process shares, and a name server that never answers would hold one far past our 12 s.
const resolver = new dnsPromises.Resolver({ timeout: 3000, tries: 1 });
async function resolveAll(host: string): Promise<{ address: string; family: number }[]> {
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
  const out: { address: string; family: number }[] = [];
  if (v4.status === "fulfilled") for (const a of v4.value) out.push({ address: a, family: 4 });
  if (v6.status === "fulfilled") for (const a of v6.value) out.push({ address: a, family: 6 });
  return out;
}

/** A DNS lookup that refuses private answers: the socket connects to what was checked. */
function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: any, callback?: any) => {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" || !options ? {} : options;
    resolveAll(hostname).then((list) => {
      if (!list.length) return cb(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
      if (!allowPrivate && list.some((a) => isPrivateIp(a.address))) {
        return cb(new CallError("blocked", "That address points inside a private network, so BeeZilla won't call it."));
      }
      if (opts.all) return cb(null, list);
      return cb(null, list[0]!.address, list[0]!.family);
    }, (err) => cb(err));
  };
}

/** The checks on one address, before any connection. */
function checkTarget(u: URL, allowPrivate: boolean): void {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new CallError("bad_url", "That address has to start with https:// or http://.");
  if (u.username || u.password) throw new CallError("bad_url", "Passwords can't go inside the address. Use a key instead.");
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  if (!PORTS.has(port) && !allowPrivate) throw new CallError("bad_url", `BeeZilla only calls the usual ports (${[...PORTS].join(", ")}), not ${port}.`);
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new CallError("bad_url", "That address has no website name in it.");
  if (!allowPrivate) {
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) {
      throw new CallError("blocked", "That address points inside a private network, so BeeZilla won't call it.");
    }
    if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) throw new CallError("bad_url", "That isn't a website address.");
    if (isIP(host) && isPrivateIp(host)) throw new CallError("blocked", "That address points inside a private network, so BeeZilla won't call it.");
  }
}

/** Sent as written, except the ones the connection itself owns. */
const NEVER_SEND = new Set(["host", "content-length", "connection", "transfer-encoding", "upgrade", "te", "trailer", "keep-alive", "expect", "proxy-connection", "proxy-authorization", "accept-encoding"]);
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,60}$/;

interface Raw {
  status: number;
  statusText: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
  truncated: boolean;
}

function once(u: URL, method: string, headers: Record<string, string>, body: string | undefined, allowPrivate: boolean, deadline: number): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const left = deadline - Date.now();
    if (left <= 0) { reject(new CallError("timeout", "It took too long to answer.")); return; }
    const lib = u.protocol === "https:" ? httpsRequest : httpRequest;
    let done = false;
    const fail = (e: unknown) => { if (!done) { done = true; reject(e); } };
    const req = lib(u, { method, headers, lookup: guardedLookup(allowPrivate) as any, agent: false }, (res) => {
      const enc = String(res.headers["content-encoding"] || "").toLowerCase();
      let stream: NodeJS.ReadableStream = res;
      try {
        if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(createGunzip());
        else if (enc === "deflate") stream = res.pipe(createInflate());
        else if (enc === "br") stream = res.pipe(createBrotliDecompress());
      } catch { /* read it as it came */ }
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      stream.on("data", (c: Buffer) => {
        if (truncated) return;
        const room = API_CALL_MAX_BYTES - size;
        if (c.length > room) {
          chunks.push(c.subarray(0, Math.max(0, room)));
          size = API_CALL_MAX_BYTES;
          truncated = true;
          req.destroy();
          finish();
          return;
        }
        chunks.push(c);
        size += c.length;
      });
      const finish = () => {
        if (done) return;
        done = true;
        resolve({ status: res.statusCode || 0, statusText: res.statusMessage || "", headers: res.headers, body: Buffer.concat(chunks), truncated });
      };
      stream.on("end", finish);
      stream.on("error", () => { if (truncated) finish(); else fail(new CallError("network", "The answer came back in a form that couldn't be read.")); });
      res.on("error", () => { if (truncated) finish(); else fail(new CallError("network", "The connection broke while it was answering.")); });
    });
    const timer = setTimeout(() => { req.destroy(); fail(new CallError("timeout", `It took longer than ${Math.round(API_CALL_TIMEOUT_MS / 1000)} seconds to answer.`)); }, left);
    req.on("close", () => clearTimeout(timer));
    req.on("error", (e: any) => {
      if (e instanceof CallError) return fail(e);
      if (e && e.cause instanceof CallError) return fail(e.cause);
      const code = String(e?.code || "");
      if (code === "ENOTFOUND" || code === "EAI_AGAIN") return fail(new CallError("network", "That address doesn't exist (its name wasn't found)."));
      if (code === "ECONNREFUSED") return fail(new CallError("network", "The server refused the connection."));
      if (code === "ECONNRESET") return fail(new CallError("network", "The connection was cut off."));
      if (/CERT|SSL|TLS|self.signed|ERR_TLS/i.test(code + " " + (e?.message ?? ""))) return fail(new CallError("network", "Its security certificate isn't valid."));
      return fail(new CallError("network", "BeeZilla couldn't reach it."));
    });
    if (body) req.write(body);
    req.end();
  });
}

/** Add a key to the address's query without re-writing the rest of it. */
function withQueryKey(u: URL, name: string, value: string): void {
  const pairs = u.search.length > 1 ? u.search.slice(1).split("&") : [];
  const enc = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
  const at = pairs.findIndex((p) => {
    const raw = p.split("=")[0] ?? "";
    let n = raw;
    try { n = decodeURIComponent(raw.replace(/\+/g, " ")); } catch { /* as written */ }
    return n.toLowerCase() === name.toLowerCase();
  });
  if (at >= 0) pairs[at] = enc; else pairs.push(enc);
  u.search = "?" + pairs.join("&");
}

function looksText(type: string, sample: Buffer): boolean {
  if (/^text\/|json|xml|javascript|x-www-form-urlencoded|yaml|csv|graphql|markdown|html/i.test(type)) return true;
  if (type && !/^application\/octet-stream/i.test(type)) return false;
  // No type given: text if the first bytes are.
  const s = sample.subarray(0, 400);
  for (const b of s) if (b === 0 || (b < 9) || (b > 13 && b < 32)) return false;
  return true;
}

function pretty(type: string, text: string): string {
  const t = text.trimStart();
  if (/json/i.test(type) || t.startsWith("{") || t.startsWith("[")) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { /* show it as it came */ }
  }
  return text;
}

const SHOWN_HEADERS = ["content-type", "content-length", "date", "server", "retry-after", "location", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "ratelimit-remaining"];

export async function callApi(input: ApiCallInput, options: { allowPrivate?: boolean; timeoutMs?: number } = {}): Promise<ApiCallResult> {
  const started = Date.now();
  const at = new Date(started).toISOString();
  const allowPrivate = options.allowPrivate ?? allowPrivateNow();
  const bad = (code: CallError["code"], error: string): ApiCallResult => ({ ok: false, reached: false, at, ms: Date.now() - started, code, error });

  const method = String(input.method ?? "GET").toUpperCase() as ApiMethod;
  if (!(API_METHODS as readonly string[]).includes(method)) return bad("bad_request", "BeeZilla can call with GET, POST, PUT, PATCH or DELETE.");
  const first = cleanUrl(input.url);
  if (!first) return bad("bad_url", "Type the address to call, starting with https://");

  // The secrets for this call: from the keys list only, never from a plain header.
  const secrets: string[] = [];
  const headers: Record<string, string> = {
    "user-agent": "BeeZilla-API-node/1 (+https://beezilla.net)",
    accept: "application/json, text/plain;q=0.9, */*;q=0.5",
    "accept-encoding": "gzip, deflate, br",
  };
  const rawHeaders = Array.isArray(input.headers) ? input.headers : [];
  for (const h of rawHeaders.slice(0, 12)) {
    const o = (h ?? {}) as Record<string, unknown>;
    const name = String(o.name ?? "").trim();
    if (!HEADER_NAME.test(name) || NEVER_SEND.has(name.toLowerCase())) continue;
    // Even a header named like a secret works for a test: it is simply never kept.
    const value = String(o.value ?? "");
    // eslint-disable-next-line no-control-regex -- header values may not hold control bytes
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value) || value.length > 2000) continue;
    headers[name.toLowerCase()] = value;
    if (isSecretName(name) && value.length >= 6) secrets.push(value);
  }
  let target: URL;
  try { target = new URL(first); } catch { return bad("bad_url", "That address isn't valid."); }
  const keyed: { name: string; where: "header" | "query"; value: string }[] = [];
  for (const k of (Array.isArray(input.keys) ? input.keys : []).slice(0, 6)) {
    const o = (k ?? {}) as Record<string, unknown>;
    const name = String(o.name ?? "").trim();
    const value = String(o.value ?? "");
    if (!name || !value) continue;
    // eslint-disable-next-line no-control-regex -- header values may not hold control bytes
    if (value.length > 2000 || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) continue;
    keyed.push({ name, where: o.in === "query" ? "query" : "header", value });
    if (value.length >= 6) secrets.push(value);
  }
  // What a key was sent as, so a redirect to another site can take exactly those back out
  // (a key's header need not look like a secret by name: "AccessKey", "X-Team").
  const keyHeaders = new Set<string>();
  const applyKeys = (u: URL, hs: Record<string, string>) => {
    for (const k of keyed) {
      if (k.where === "query") withQueryKey(u, k.name, k.value);
      else if (HEADER_NAME.test(k.name) && !NEVER_SEND.has(k.name.toLowerCase())) { hs[k.name.toLowerCase()] = k.value; keyHeaders.add(k.name.toLowerCase()); }
    }
  };
  applyKeys(target, headers);

  let body: string | undefined;
  if (method !== "GET") {
    const b = block(input.body, 6000);
    if (b) {
      body = b;
      if (!headers["content-type"]) headers["content-type"] = /^\s*[{[]/.test(b) ? "application/json" : "text/plain; charset=utf-8";
      headers["content-length"] = String(Buffer.byteLength(b));
    }
  }

  const deadline = started + (options.timeoutMs ?? API_CALL_TIMEOUT_MS);
  let current = target;
  const curMethod: string = method;
  const curBody = body;
  let curHeaders = headers;
  let redirects = 0;
  try {
    for (;;) {
      checkTarget(current, allowPrivate);
      const raw = await once(current, curMethod, curHeaders, curBody, allowPrivate, deadline);
      const loc = raw.headers.location;
      if (loc && raw.status >= 300 && raw.status < 400 && (curMethod === "GET" || curMethod === "HEAD") && redirects < API_CALL_MAX_REDIRECTS) {
        let next: URL;
        try { next = new URL(String(loc), current); } catch { next = current; }
        if (next !== current) {
          redirects++;
          // Another site never gets the keys: they were for the address that was typed. The
          // same site moving from http to https is still the same site.
          const sameSite = next.origin === current.origin || (next.hostname === current.hostname && current.protocol === "http:" && next.protocol === "https:");
          if (!sameSite) {
            const stripped: Record<string, string> = {};
            for (const [k, v] of Object.entries(curHeaders)) if (!isSecretName(k) && !keyHeaders.has(k)) stripped[k] = v;
            curHeaders = stripped;
            next.search = "";
          }
          current = next;
          continue;
        }
      }
      const type = String(raw.headers["content-type"] || "").split(";")[0]!.trim().toLowerCase();
      const isText = looksText(type, raw.body);
      const text = isText ? raw.body.toString("utf8") : "";
      // A service may echo a key back in any form: as it was, URL-encoded, or JSON-escaped
      // ("a/b" is "a\/b" in some answers). Taken out after the answer is made readable too.
      const forms = new Set<string>();
      for (const s of secrets) {
        if (!s) continue;
        forms.add(s);
        forms.add(encodeURIComponent(s));
        forms.add(JSON.stringify(s).slice(1, -1));
      }
      const redact = (t: string) => { for (const f of forms) if (f.length >= 6 && t.includes(f)) t = t.split(f).join("••••"); return t; };
      let preview = isText ? redact(pretty(type, redact(text))) : `(${raw.body.length.toLocaleString("en-US")} bytes of ${type || "data"} — not text, so not shown)`;
      let cut = raw.truncated;
      if (preview.length > API_PREVIEW_CHARS) { preview = preview.slice(0, API_PREVIEW_CHARS).replace(/[\uD800-\uDBFF]$/, ""); cut = true; }
      const shown: [string, string][] = [];
      for (const name of SHOWN_HEADERS) {
        const v = raw.headers[name];
        if (v) shown.push([name, tidy(Array.isArray(v) ? v.join(", ") : v, 160)]);
      }
      // The address shown back never carries a key's value.
      const finalUrl = new URL(current.toString());
      for (const k of keyed) if (k.where === "query") withQueryKey(finalUrl, k.name, "");
      return {
        ok: true,
        reached: true,
        at,
        status: raw.status,
        statusText: tidy(raw.statusText, 60),
        ms: Date.now() - started,
        type,
        bytes: raw.body.length,
        preview,
        truncated: cut,
        headers: shown,
        finalUrl: finalUrl.toString(),
        redirects,
      };
    }
  } catch (e) {
    if (e instanceof CallError) return bad(e.code, e.message);
    return bad("network", "BeeZilla couldn't reach it.");
  }
}
