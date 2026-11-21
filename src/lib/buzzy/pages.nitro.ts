/**
 * Nitro handler for extension-less /buzzy/* pages.
 *
 * GET /buzzy/library → public/buzzy/library.html
 * GET /buzzy/talk    → public/buzzy/talk.html
 * GET /buzzy/memory  → public/buzzy/memory.html
 *
 * Do NOT ship a `public/buzzy/index.html`: Nitro's static handler answers
 * `/buzzy/` with it BEFORE this route runs, so the 302 below never fires (it
 * returned 200 with a JS redirect instead — BZ-4). The Library page therefore
 * has its own filename.
 *
 * Path is sanitized (no traversal); only known pages are served.
 */

import { defineEventHandler, getHeader, getMethod, sendRedirect, setResponseStatus } from "h3";
import type { H3Event } from "h3";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openpanelClientId } from "@/lib/analytics-id";

/**
 * Product analytics for the static pages.
 *
 * Every page a human actually uses (Talk, Library, Wallet, landing…) is served
 * from public/buzzy/*.html by this handler, NOT by React — and @/lib/analytics is
 * imported only by the React routes (__root/login/register). So the BeeZilla
 * OpenPanel project saw nothing from beezilla.net: zero signups on 2026-11-17
 * were visible in analytics while the project looked "installed" in the dashboard.
 *
 * Injected here, once, for the same reason the nav is: 18 pages cannot each be
 * trusted to keep their own copy honest. The shim is OpenPanel's documented
 * script-tag snippet verbatim — the queue-proxy shape matters, since op1.js drains
 * whatever window.op.q already holds before it initialises.
 */
const opSnippet = (host: string | undefined) =>
  [
    "<script>",
    "window.op=window.op||function(){var n=[];return new Proxy(function(){arguments.length&&n.push([].slice.call(arguments))},{get:function(t,r){return\"q\"===r?n:function(){n.push([r].concat([].slice.call(arguments)))}} ,has:function(t,r){return\"q\"===r}}) }();",
    `window.op('init',{clientId:'${openpanelClientId(host)}',trackScreenViews:true,trackOutgoingLinks:false,trackAttributes:true});`,
    "</script>",
    '<script src="https://openpanel.dev/op1.js" defer async></script>',
  ].join("");

// Every name here must have a file in public/buzzy — "form" was listed with no
  // form.html behind it, so /buzzy/form answered 404 from a route that claimed
  // to serve it.
const PAGES = new Set(["talk", "memory", "remember", "experts", "library", "profile", "landing", "login", "recipes", "wallet", "upload", "graph", "capabilities", "project", "sketch", "studio", "shared", "join", "download", "testers"]);
// Opened by people who were sent a share or invitation link, often not BeeZilla
// users yet: served as written, without the app's nav, account menu or nav.js.
const STANDALONE = new Set(["shared", "join"]);

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

/**
 * The two pages whose only job is signing in. Someone who is already signed in
 * never gets them: they are sent on to Talk before a byte of either is written.
 *
 * Owner, 2026-11-21, on Brave: "when you're already logged in and you go to the
 * website again… it forces you back to the login screen. But when you click any
 * of the buttons in the top right, you're actually back in BeeZilla, logged in."
 * Measured: a signed-in visitor was served both pages as-is (the welcome page
 * with Log in / Register, the Welcome back form), their own name in the top
 * right. Every sign-in walks through these two addresses, so they are the ones
 * the address bar suggests, a bookmark or a top-sites tile holds and a restored
 * tab reopens. Neither page asked who was visiting; only the places in the bar
 * led back in.
 */
const SIGN_IN_PAGES = new Set(["landing", "login"]);

/**
 * Query words that ask the sign-in page for one of its own steps, shown even to
 * someone who IS signed in: the set-password step after an emailed link
 * (`step`), and the message for a link that expired or failed (`link`,
 * `error`). Every other word leaves it a plain visit — `next`, `mode`,
 * `verified`, and the `utm_*` / `fbclid` / `gclid` a shared or advertised link
 * carries, which must not decide whether a signed-in visitor is recognised.
 */
const PAGE_STEPS = new Set(["step", "link", "error"]);

/** Where a signed-in visitor goes instead. */
const SIGNED_IN_HOME = "/buzzy/talk";

/**
 * `?next=` on the sign-in page, when it is safe to follow: a BeeZilla page on
 * this origin, and not one of the sign-in pages (that would be a loop). Parsed
 * as a URL rather than eyeballed, so `//host`, `/\host` and `/buzzy/../x` cannot
 * slip past a prefix check.
 */
export function signedInDestination(page: string, query: URLSearchParams): string {
  const next = page === "login" ? query.get("next") : null;
  if (!next || next.charAt(0) !== "/") return SIGNED_IN_HOME;
  let u: URL;
  try {
    u = new URL(next, "http://bz.invalid");
  } catch {
    return SIGNED_IN_HOME;
  }
  if (u.origin !== "http://bz.invalid") return SIGNED_IN_HOME;
  const path = u.pathname.replace(/\.html$/, "").replace(/\/+$/, "");
  if (!/^\/buzzy(\/|$)/.test(path)) return SIGNED_IN_HOME;
  if (/^\/buzzy\/(landing|login)$/.test(path)) return SIGNED_IN_HOME;
  return u.pathname + u.search + u.hash;
}

/**
 * How long a sign-in page waits to learn who is asking. These pages used to be
 * static; a slow or unreachable session store must not hold them. A normal
 * lookup takes milliseconds.
 */
const SESSION_CHECK_MS = 1500;

/** `check`'s answer, or `null` once `ms` have passed. */
export function answerWithin<T>(check: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([check, late]).finally(() => clearTimeout(timer));
}

/**
 * Is a real session behind this request? Same answer the APIs act on
 * (`getSessionUserFromHeaders`, which also refuses a disabled account). A
 * request with no cookie at all is answered without loading auth; a check that
 * fails or runs out of time answers "no", which serves the sign-in page exactly
 * as before.
 */
async function signedIn(event: H3Event): Promise<boolean> {
  if (!getHeader(event, "cookie")) return false;
  try {
    const { getSessionUserFromHeaders } = await import("@/lib/auth/verify.server");
    return Boolean(await answerWithin(getSessionUserFromHeaders(event.req.headers), SESSION_CHECK_MS));
  } catch {
    return false;
  }
}

export default defineEventHandler(async (event) => {
  const method = getMethod(event);
  // HEAD must answer exactly like GET with the body removed. It used to 405,
  // which breaks every uptime monitor, CDN reachability check and link
  // validator that probes with HEAD — the page was fine and the check said no.
  if (method !== "GET" && method !== "HEAD") {
    setResponseStatus(event, 405);
    return { error: "method not allowed" };
  }
  const headOnly = method === "HEAD";
  // Every HTML answer goes through `out`, so HEAD can never forget to drop the
  // body while keeping the status and content-type.
  const out = (body: string, status = 200) => html(headOnly ? "" : body, status);

  // event.path includes the query string in this runtime. Strip it before
  // matching or /buzzy/talk?job=… is not a known page.
  const path = (event.path ?? "").split("?")[0].replace(/\/+$/, "") || "/buzzy";
  const segments = path.split("/").filter(Boolean); // ["buzzy", maybe "talk"]

  // `/buzzy` and `/buzzy/` are not a page of their own any more: Talk is the
  // consolidated work surface and index.html serves only /buzzy/library. A
  // server-side 302 replaces the old 200 + `location.replace()` in page JS —
  // the old shape answered 200 with a Jobs title and a redirect script, which
  // looked to a crawler (and to QA) like a real page that never rendered.
  if (segments.length === 1) {
    return sendRedirect(event, "/buzzy/talk", 302);
  }
  let name: string;
  if (segments.length === 2) {
    name = segments[1];
  } else {
    setResponseStatus(event, 404);
    return out("<h1>Not found</h1>", 404);
  }

  if (name.includes("/") || name.includes("\\")) {
    setResponseStatus(event, 404);
    return out("<h1>Not found</h1>", 404);
  }

  // Asset (has an extension, e.g. brand/*.png, sow-pdf.js) → serve the static
  // file from public/buzzy so this route can shadow /buzzy/** without breaking
  // assets. Anything else that isn't a known page is a 404.
  const ASSET_MIME: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".js": "text/javascript",
    ".css": "text/css",
    ".ico": "image/x-icon",
  };

  const baseDir = (sub: string) => resolve(process.cwd(), sub, "buzzy");
  const readBuzzyFile = async (rel: string): Promise<Buffer | null> => {
    const candidates = [
      join(baseDir("public"), rel),
      join(baseDir(".output/public"), rel),
    ];
    for (const f of candidates) {
      try {
        return await readFile(f);
      } catch {
        /* try next */
      }
    }
    return null;
  };

  if (name.includes(".")) {
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
    const mime = ASSET_MIME[ext];
    if (!mime) {
      setResponseStatus(event, 404);
      return out("<h1>Not found</h1>", 404);
    }
    const rel = segments.slice(1).join("/");
    const data = await readBuzzyFile(rel);
    if (!data) {
      setResponseStatus(event, 404);
      return out("<h1>Not found</h1>", 404);
    }
    // HEAD gets the same headers and no body.
    return new Response(headOnly ? null : new Uint8Array(data), {
      headers: { "content-type": mime },
    });
  }

  if (!PAGES.has(name)) {
    setResponseStatus(event, 404);
    return out("<h1>Not found</h1>", 404);
  }

  // Signed in already? Then this is not the page for you: on to Talk (or to the
  // `next` the sign-in page was given). Both answers say `no-store`, because the
  // page now depends on who asks: a copy kept from a signed-out visit must not be
  // replayed by Back or a restored tab once you have signed in. Not for the shell's
  // own fetch (`x-bz-shell`): it would follow the redirect and paint Talk under
  // this address. nav.js no longer soft-navigates to these pages; this covers a
  // copy of the old nav.js still in someone's cache.
  const signInPage = SIGN_IN_PAGES.has(name);
  if (signInPage && !getHeader(event, "x-bz-shell")) {
    // Everything after the FIRST "?": a `next` written without encoding carries a
    // "?" of its own, and split("?")[1] would cut its query off.
    const raw = event.path ?? "";
    const query = new URLSearchParams(raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "");
    const step = [...query.keys()].some((k) => PAGE_STEPS.has(k));
    if (!step && (await signedIn(event))) {
      return new Response(null, {
        status: 302,
        headers: { location: signedInDestination(name, query), "cache-control": "no-store" },
      });
    }
  }

  // `/buzzy/library` is the Library (documents vault) view of the app shell and
  // has its own file now: a `public/buzzy/index.html` was answered by Nitro's
  // static handler for `/buzzy/`, which is exactly the 200-with-a-JS-redirect
  // shape BZ-4 reported.
  const fileName = name;

  // Dev: repo root/public/buzzy. Prod: cwd is the repo root too (startCommand
  // runs `node .output/server/index.mjs` from the project root).
  const file = resolve(process.cwd(), "public", "buzzy", `${fileName}.html`);
  let body = await readBuzzyFile(`${fileName}.html`);
  if (!body) {
    // Production fallback: Nitro copies public/ into .output/public.
    body = await readBuzzyFile(join(".output", "public", "buzzy", `${fileName}.html`));
  }
  if (!body) {
    setResponseStatus(event, 404);
    return out("<h1>Not found</h1>", 404);
  }
  // One chrome for every page: the shared nav (company dropdown + settings gear) is
  // injected at serve time, so a new page inherits it and no page can drift.
  // Idempotent — a page that already includes it is left alone.
  // LAST "</body>", not the first: talk.html builds a Word export by concatenating
  // an HTML string that itself contains "</body>", and replacing the first match
  // injected a <script> tag into JavaScript source — "Invalid or unexpected token",
  // a dead page, and the bug was invisible until the browser ran it.
  // The nav ROW is written once, here, and substituted into every page. Pages
  // used to hand-write it and drifted into three shapes — ten anchors on
  // talk/sketch/studio/capabilities/project, eight on the rest, none on landing
  // — so the same URL shipped a different nav depending on where you landed,
  // and four pages still shipped `target="_blank"` on Library long after the
  // new tab was supposed to be gone (BZ-11, BZ-14). Substituting the row makes
  // the shipped markup identical by construction; nav.js then owns state (active
  // link, account menu, company switcher) and never structure.
  // Wording and order are nav.js LINKS and talk.html #bzPlaces: the main five,
  // then the extra places. This row is the fallback a visitor sees if nav.js never
  // runs or the header fetch fails, so it must say the same words in the same order
  // — "Studio"/"Capabilities"/"Honey Drops" here while the page said "Music studio"/
  // "What BeeZilla can do"/"Honey" is two navs for one site.
  const NAV_ROW = [
    '<a href="/buzzy/talk" data-nav="talk">Talk</a>',
    // No target, no rel: one document, one mic. The shell keeps Talk alive.
    '<a href="/buzzy/library" data-nav="library">Library</a>',
    '<a href="/buzzy/memory" data-nav="memory">Memory</a>',
    '<a href="/buzzy/experts" data-nav="experts">Experts</a>',
    '<a href="/buzzy/recipes" data-nav="recipes">Recipes</a>',
    // The extra places, same words as #bzPlaces on Talk: Sketch, Music studio,
    // What BeeZilla can do, Download, Honey, Publish.
    '<a href="/buzzy/sketch" data-nav="sketch">Sketch</a>',
    '<a href="/buzzy/studio" data-nav="studio">Music studio</a>',
    '<a href="/buzzy/capabilities" data-nav="capabilities">What BeeZilla can do</a>',
    // The installer lives in its own release line, but it is still a place in
    // the product: a visitor who wants the desktop app should not have to find
    // a README to get it.
    '<a href="/buzzy/download" data-nav="download">Download</a>',
    '<a href="/buzzy/wallet" data-nav="wallet">Honey</a>',
    '<a href="/buzzy/upload" data-nav="publish">Publish</a>',
    // Empty on purpose: the page cannot know who is signed in, and the text used to
    // be `Sign in`, which every signed-in reader saw for a round trip on every load
    // (BZ-15 residual — loudest on Sketch, whose header is otherwise empty). The
    // chrome paints the last known identity from localStorage, then the real answer.
    // A blank 5.5rem slot is a skeleton; the word "Sign in" over a real name is a lie.
    '<a href="/buzzy/landing" class="account-link" id="accountLink" aria-label="Account"></a>',
  ].join("\n      ");

  let page = body.toString("utf8");
  if (STANDALONE.has(fileName)) return out(page);
  page = page.replace(
    /(<nav id="bzNav"[^>]*>)[\s\S]*?(<\/nav>)/,
    (_m, open: string, close: string) => `${open}\n      ${NAV_ROW}\n    ${close}`,
  );
  if (!page.includes("/buzzy/nav.js")) {
    const at = page.lastIndexOf("</body>");
    if (at > 0) {
      page = page.slice(0, at) + '<script src="/buzzy/nav.js" defer></script>' + page.slice(at);
    }
  }
  // nav.js BUILDS the chrome on every page, so nav.css has to be there too. It was
  // only in the fourteen pages that hand-wrote the link; landing.html had none, and
  // on the sign-out landing (where unsigned /buzzy/talk and /buzzy/library send you)
  // the bar painted with a sheet-metal white "More" button and every menu item
  // running together as unstyled text. Same seam as nav.js: one link, every page,
  // last in <head> so it wins ties against the page's own inline <style>.
  if (!page.includes("/buzzy/nav.css")) {
    const at = page.lastIndexOf("</head>");
    if (at > 0) {
      page = page.slice(0, at) + '<link rel="stylesheet" href="/buzzy/nav.css" />' + page.slice(at);
    }
  }
  // Analytics rides the same serve-time seam as nav.js, and is skipped when the
  // page already carries the snippet so a double-include cannot double-count.
  if (!page.includes("openpanel.dev/op1.js")) {
    const at = page.lastIndexOf("</body>");
    // Host, not the build: this one process answers beezilla.net and
    // app.devboards.ai, and only the request knows which project it is.
    if (at > 0) page = page.slice(0, at) + opSnippet(getHeader(event, "host")) + page.slice(at);
  }
  const res = out(page);
  // A sign-in page differs by visitor now (see the redirect above), so no copy of
  // it may be kept and shown again without asking.
  if (signInPage) res.headers.set("cache-control", "no-store");
  return res;
});
