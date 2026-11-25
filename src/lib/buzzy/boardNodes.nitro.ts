/**
 * /api/buzzy/nodes — the server half of the Idea Board's "More" nodes.
 *
 *   POST /api/buzzy/nodes/api-call                  → { method, url, headers, keys, body } : try an API node
 *   GET  /api/buzzy/nodes/browser                   → is the server browser set up, and what is left today
 *   POST /api/buzzy/nodes/browser                   → { startUrl?, steps? } : open a browser   → { id }
 *   GET  /api/buzzy/nodes/browser/<id>/stream       → Server-Sent Events: pictures of the page, steps, where it runs
 *   POST /api/buzzy/nodes/browser/<id>/input        → { events: [...] } : clicks, keys, scrolling, pasted text
 *   POST /api/buzzy/nodes/browser/<id>/goto         → { url }
 *   POST /api/buzzy/nodes/browser/<id>/history      → { action: "back" | "forward" | "reload" }
 *   POST /api/buzzy/nodes/browser/<id>/record       → { on: boolean, keep?: boolean }
 *   POST /api/buzzy/nodes/browser/<id>/steps        → { delete: index } | { steps: [...] }
 *   POST /api/buzzy/nodes/browser/<id>/replay       → { steps? } : play the recording in this browser
 *   DELETE /api/buzzy/nodes/browser/<id>            → close it
 *
 * Everything needs a signed-in person; a browser belongs to the person who opened it and
 * no one else can reach it. Lockdown (the privacy mode) turns both nodes off, like every
 * other thing that leaves BeeZilla. The browser is metered by the second against the plan.
 *
 * What the browser is and why it runs where it does: remoteBrowser.ts. What the API call is
 * allowed to reach: apiNode.ts.
 */
import { defineEventHandler, getMethod } from "h3";
import { getSessionUserFromHeaders } from "@/lib/auth/verify.server";
import { getSql } from "@/lib/db";
import { callApi } from "./apiNode";
import {
  BrowserError,
  browserConfigured,
  closeBrowserSession,
  currentBrowserSession,
  getBrowserSession,
  idleSeconds,
  openBrowserSession,
  providerKind,
  sessionSeconds,
  type InputEvent,
  type SessionEvent,
} from "./remoteBrowser";
import { cleanSteps, cleanUrl } from "./boardNodes";
import { PLANS, checkQuota, getEntitlement, recordUsage, unitsInWindow } from "./entitlements";
import { recordToolCall } from "./toolTelemetry";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function headersFromEvent(event: any): Headers {
  const rawHeaders = event.node?.req?.headers ?? event.req?.headers;
  if (rawHeaders instanceof Headers) return rawHeaders;
  const init: [string, string][] = Object.entries(
    (rawHeaders ?? {}) as Record<string, string | string[] | undefined>,
  ).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v ?? "")]);
  return new Headers(init);
}

/** A page on another site cannot drive this: the request has to come from our own pages. */
function sameOrigin(headers: Headers): boolean {
  const origin = headers.get("origin");
  if (!origin) return true;
  const host = (headers.get("x-forwarded-host") || headers.get("host") || "").split(",")[0]!.trim().toLowerCase();
  try { return new URL(origin).host.toLowerCase() === host; } catch { return false; }
}

async function readJson(event: any, maxBytes: number): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; res: Response }> {
  // Said too big before a byte of it is read.
  const declared = Number(headersFromEvent(event).get("content-length") ?? 0);
  if (declared > maxBytes) return { ok: false, res: json(413, { ok: false, error: "That is too much to send at once.", code: "too_big" }) };
  let text = "";
  try { text = await event.req.text(); } catch { text = ""; }
  if (text.length > maxBytes) return { ok: false, res: json(413, { ok: false, error: "That is too much to send at once.", code: "too_big" }) };
  if (!text) return { ok: true, body: {} };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ok: true, body: parsed as Record<string, unknown> };
  } catch { /* fall through */ }
  return { ok: false, res: json(400, { ok: false, error: "That request could not be read.", code: "bad_request" }) };
}

const lockSeen = new Map<string, { v: LockState; at: number }>();
/**
 * "off", "on", or "unknown" — never a silent "off". The old shape caught the database
 * error and set v = false, so a Postgres hiccup switched Lockdown off and both More
 * nodes (API use, the server browser) happily made outbound calls. Everything else in
 * this product fails closed; so does this. "unknown" is separate from "on" so the
 * refusal can say what is actually wrong instead of claiming a mode the person never set.
 */
type LockState = "off" | "on" | "unknown";
async function lockState(userId: string, fresh = true): Promise<LockState> {
  // A browser that is already open is checked every few seconds, not on every click.
  const hit = lockSeen.get(userId);
  if (!fresh && hit && Date.now() - hit.at < 5000) return hit.v;
  let v: LockState = "unknown";
  try {
    const sql = await getSql();
    const rows = await sql<{ mode: string }>`SELECT mode FROM buzzy_privacy_mode WHERE user_id = ${userId} LIMIT 1`;
    v = rows[0]?.mode === "lockdown" ? "on" : "off";
  } catch {
    v = "unknown";
  }
  if (lockSeen.size > 2000) lockSeen.clear();
  lockSeen.set(userId, { v, at: Date.now() });
  return v;
}
const LOCKDOWN_SAYS = "Lockdown is on, and nothing leaves BeeZilla in that mode. The privacy control on the Talk bar switches it back.";
const LOCK_UNKNOWN_SAYS = "BeeZilla can't read your privacy setting right now, and nothing leaves it until it can. Try again in a moment.";
/** Null when the state permits an outbound call; the refusal response otherwise. */
function lockRefusal(state: LockState): Response | null {
  if (state === "off") return null;
  if (state === "on") return json(403, { ok: false, error: LOCKDOWN_SAYS, code: "lockdown" });
  return json(503, { ok: false, error: LOCK_UNKNOWN_SAYS, code: "privacy_unknown" });
}

// ── Trying an API node: a few at a time ────────────────────────────────────

const apiCalls = new Map<string, number[]>();
const apiBusy = new Map<string, number>();
const API_PER_WINDOW = 30;
const API_WINDOW_MS = 10 * 60_000;

function apiAllowed(userId: string): { ok: true } | { ok: false; error: string } {
  const now = Date.now();
  const recent = (apiCalls.get(userId) ?? []).filter((t) => now - t < API_WINDOW_MS);
  if (recent.length >= API_PER_WINDOW) {
    return { ok: false, error: `That's ${API_PER_WINDOW} tries in ten minutes. Wait a few minutes and try again.` };
  }
  if ((apiBusy.get(userId) ?? 0) >= 2) return { ok: false, error: "Two tries are still running. Wait for one to finish." };
  recent.push(now);
  apiCalls.set(userId, recent);
  return { ok: true };
}

async function tryApi(userId: string, body: Record<string, unknown>): Promise<Response> {
  const refused = lockRefusal(await lockState(userId));
  if (refused) return refused;
  // The daily ceiling a plan gives (checkQuota, scope "api"). Without it a free account
  // was a server-address egress proxy — the flood limiter below is per instance and in
  // memory, so it reset on every restart and never counted what the day had spent.
  const quota = await checkQuota({ userId, scope: "api", units: 1 });
  if (!quota.ok) {
    return json(quota.code === "usage_unknown" ? 503 : 403, { ok: false, code: quota.code ?? "quota_exhausted", error: quota.error ?? "API use is not available." });
  }
  const gate = apiAllowed(userId);
  if (!gate.ok) return json(429, { ok: false, error: gate.error, code: "slow_down" });
  apiBusy.set(userId, (apiBusy.get(userId) ?? 0) + 1);
  try {
    const result = await callApi(body);
    // Identity and timing only: never the address, the keys or the answer.
    const sql = await getSql().catch(() => null);
    if (sql) {
      await recordToolCall(sql, {
        userId, tool: "api_node", ok: result.ok, ms: result.ms,
        errorCode: result.ok ? null : result.code, bytes: result.ok ? result.bytes : null, path: result.ok ? String(result.status) : null,
      });
    }
    return json(200, result);
  } finally {
    apiBusy.set(userId, Math.max(0, (apiBusy.get(userId) ?? 1) - 1));
  }
}

// ── The server browser ─────────────────────────────────────────────────────

async function browserInfo(userId: string): Promise<Response> {
  const configured = browserConfigured();
  const ent = await getEntitlement(userId);
  const limit = PLANS[ent.plan]?.browserSecondsPerDay ?? 0;
  // Display only: when the ledger cannot be read, say so rather than claiming either
  // "nothing used" or "all used up". Opening goes through checkQuota, which refuses.
  let used: number;
  try {
    used = await unitsInWindow(userId, "browser");
  } catch {
    return json(503, { ok: false, code: "usage_unknown", error: "BeeZilla can't read your server browser time right now. Try again in a moment." });
  }
  const open = currentBrowserSession(userId);
  return json(200, {
    ok: true,
    configured,
    provider: providerKind(),
    plan: ent.plan,
    secondsLeft: Math.max(0, Math.floor(limit - used)),
    secondsPerDay: limit,
    maxSeconds: sessionSeconds(),
    idleSeconds: idleSeconds(),
    open: open ? { id: open.id, recording: open.recording } : null,
  });
}

async function openBrowser(userId: string, body: Record<string, unknown>): Promise<Response> {
  if (!browserConfigured()) {
    return json(503, { ok: false, code: "not_configured", error: "The server browser isn't set up on this BeeZilla yet, so it can't be opened." });
  }
  const refused = lockRefusal(await lockState(userId));
  if (refused) return refused;
  const quota = await checkQuota({ userId, scope: "browser", units: 30 });
  if (!quota.ok) {
    return json(quota.code === "usage_unknown" ? 503 : 403, { ok: false, code: quota.code ?? "quota_exhausted", error: `Not today: ${quota.error}.` });
  }
  // The browser may stay open only as long as today's time lasts, not for the whole session limit.
  const left = Math.floor((quota.limit ?? 0) - (quota.used ?? 0));
  const startUrl = body.startUrl ? cleanUrl(body.startUrl, 2000) : "";
  const started = Date.now();
  try {
    const session = await openBrowserSession(userId, {
      startUrl: startUrl || undefined,
      steps: Array.isArray(body.steps) ? body.steps : undefined,
      maxSeconds: left > 0 ? left : undefined,
      // Counted as it goes (a crash or a restart loses at most the last minute), not only at the end.
      onBill: (seconds) => { void recordUsage({ userId, scope: "browser", units: seconds, ms: seconds * 1000, status: "ok", code: "open" }); },
      onClosed: ({ seconds, reason }) => {
        void getSql().then((sql) => recordToolCall(sql, { userId, tool: "browser_node", ok: true, ms: seconds * 1000, errorCode: null, path: reason.slice(0, 40) })).catch(() => {});
      },
    });
    return json(200, { ok: true, id: session.id, ms: Date.now() - started });
  } catch (e) {
    const err = e instanceof BrowserError ? e : new BrowserError("start_failed", "The browser could not be started.");
    console.warn("[buzzy/browser-node] start failed:", err.code, err.message);
    void getSql().then((sql) => recordToolCall(sql, { userId, tool: "browser_node", ok: false, ms: Date.now() - started, errorCode: err.code })).catch(() => {});
    return json(err.code === "not_configured" ? 503 : 502, { ok: false, code: err.code, error: err.message });
  }
}

function stream(session: NonNullable<ReturnType<typeof getBrowserSession>>): Response {
  const enc = new TextEncoder();
  let unsub: () => void = () => {};
  let beat: ReturnType<typeof setInterval> | undefined;
  let done = false;
  const body = new ReadableStream<Uint8Array>(
    {
      async start(controller) {
        const finish = () => {
          if (done) return;
          done = true;
          unsub();
          if (beat) clearInterval(beat);
          try { controller.close(); } catch { /* already closed by the client */ }
        };
        const send = (name: string, data: unknown, droppable = false) => {
          if (done) return;
          // A slow connection skips pictures, never steps or messages.
          if (droppable && (controller.desiredSize ?? 1) < 2) return;
          try { controller.enqueue(enc.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { finish(); }
        };
        send("hello", session.hello());
        unsub = session.subscribe((ev: SessionEvent) => {
          if (ev.type === "ended") { send("ended", ev); finish(); return; }
          send(ev.type, ev, ev.type === "frame");
        }, finish);
        const first = await session.currentFrame();
        if (first) send("frame", first);
        if (done) return;            // the window went away while the first picture was being taken
        beat = setInterval(() => {
          if (done) return;
          try { controller.enqueue(enc.encode(": ping\n\n")); } catch { finish(); }
        }, 15_000);
      },
      cancel() {
        done = true;
        unsub();
        if (beat) clearInterval(beat);
      },
    },
    new CountQueuingStrategy({ highWaterMark: 8 }),
  );
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

const gone = () => json(404, { ok: false, code: "gone", error: "That browser has closed. Press Record to open a new one." });

async function browserCall(event: any, method: string, userId: string, id: string, action: string): Promise<Response> {
  const session = getBrowserSession(id, userId);
  // Lockdown switched on while a browser is open ends it: nothing leaves BeeZilla in that mode.
  // A privacy setting that cannot be read refuses the action but keeps the session: a
  // transient database hiccup must not destroy work (or bill for a browser nobody can use).
  if (session && method !== "DELETE") {
    const st = await lockState(userId, false);
    if (st === "on") {
      await closeBrowserSession(id, userId, "closed");
      return json(403, { ok: false, error: LOCKDOWN_SAYS, code: "lockdown" });
    }
    if (st === "unknown") return lockRefusal(st) as Response;
  }
  if (method === "GET" && action === "stream") {
    if (!session) return gone();
    return stream(session);
  }
  if (method === "DELETE" && action === "") {
    const closed = await closeBrowserSession(id, userId, "closed");
    return json(200, { ok: true, closed });
  }
  if (method !== "POST") return json(405, { ok: false, error: "method not allowed" });
  if (!session) return gone();
  const limit = action === "input" ? 64 * 1024 : 200 * 1024;
  const read = await readJson(event, limit);
  if (!read.ok) return read.res;
  const b = read.body;

  if (action === "input") {
    // What is still waiting to reach the page: a flood is turned away, not queued for ever.
    if (session.backlog() > 300) return json(429, { ok: false, code: "slow_down", error: "The browser is behind. Give it a moment." });
    const events = (Array.isArray(b.events) ? b.events : []).filter((e) => e && typeof e === "object") as InputEvent[];
    // Not awaited past the queue: the pictures come back on the stream.
    void session.input(events).catch(() => {});
    return json(200, { ok: true });
  }
  if (action === "goto") {
    const r = await session.goto(String(b.url ?? ""));
    return json(r.ok ? 200 : 400, r.ok ? { ok: true, url: r.url } : { ok: false, error: r.error, code: "bad_request" });
  }
  if (action === "history") {
    const a = b.action === "back" || b.action === "forward" || b.action === "reload" ? b.action : null;
    if (!a) return json(400, { ok: false, error: "back, forward or reload", code: "bad_request" });
    if (session.replaying) return json(409, { ok: false, error: "BeeZilla is playing the steps. Wait for it to finish.", code: "busy" });
    await session.history(a);
    return json(200, { ok: true });
  }
  if (action === "record") {
    if (session.replaying) return json(409, { ok: false, error: "BeeZilla is playing the steps. Wait for it to finish.", code: "busy" });
    await session.setRecording(b.on === true, b.keep === true);
    return json(200, { ok: true, recording: session.recording });
  }
  if (action === "steps") {
    if (typeof b.delete === "number") session.deleteStep(b.delete);
    else if (Array.isArray(b.steps)) session.loadSteps(cleanSteps(b.steps));
    return json(200, { ok: true, steps: session.steps.length });
  }
  if (action === "replay") {
    if (session.replaying) return json(409, { ok: false, error: "It is already playing.", code: "busy" });
    const steps = Array.isArray(b.steps) ? b.steps : session.steps;
    // Runs on; progress comes back on the stream.
    void session.replay(steps).catch(() => {});
    return json(200, { ok: true });
  }
  return json(404, { ok: false, error: "not found" });
}

export default defineEventHandler(async (event: any) => {
  const method = getMethod(event);
  const headers = headersFromEvent(event);
  const user = await getSessionUserFromHeaders(headers);
  if (!user) return json(401, { ok: false, error: "Sign in required", code: "signed_out" });
  if (method !== "GET" && !sameOrigin(headers)) return json(403, { ok: false, error: "That request came from another site.", code: "bad_origin" });

  const full = String(event.path ?? "");
  const path = (full.includes("?") ? full.slice(0, full.indexOf("?")) : full).replace(/\/+$/, "");
  const rest = path.replace(/^\/api\/buzzy\/nodes\/?/, "");
  const parts = rest.split("/").filter(Boolean);

  if (parts[0] === "api-call" && parts.length === 1) {
    if (method !== "POST") return json(405, { ok: false, error: "method not allowed" });
    const read = await readJson(event, 64 * 1024);
    if (!read.ok) return read.res;
    return tryApi(user.id, read.body);
  }
  if (parts[0] === "browser") {
    if (parts.length === 1) {
      if (method === "GET") return browserInfo(user.id);
      if (method === "POST") {
        const read = await readJson(event, 200 * 1024);
        if (!read.ok) return read.res;
        return openBrowser(user.id, read.body);
      }
      return json(405, { ok: false, error: "method not allowed" });
    }
    if (parts.length <= 3 && /^[0-9a-f]{32}$/.test(parts[1]!)) return browserCall(event, method, user.id, parts[1]!, parts[2] ?? "");
  }
  return json(404, { ok: false, error: "not found" });
});

