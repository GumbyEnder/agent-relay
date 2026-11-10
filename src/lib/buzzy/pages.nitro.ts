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

import { defineEventHandler, getMethod, sendRedirect, setResponseStatus } from "h3";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Every name here must have a file in public/buzzy — "form" was listed with no
  // form.html behind it, so /buzzy/form answered 404 from a route that claimed
  // to serve it.
const PAGES = new Set(["talk", "memory", "remember", "experts", "library", "profile", "landing", "login", "recipes", "wallet", "upload", "graph", "capabilities", "project", "sketch", "studio"]);

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

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
  // One chrome for every page: the shared nav (company dropdown + Ask panel) is
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
  const NAV_ROW = [
    '<a href="/buzzy/talk" data-nav="talk">Talk</a>',
    '<a href="/buzzy/sketch" data-nav="sketch">Sketch</a>',
    '<a href="/buzzy/studio" data-nav="studio">Studio</a>',
    // No target, no rel: one document, one mic. The shell keeps Talk alive.
    '<a href="/buzzy/library" data-nav="library">Library</a>',
    '<a href="/buzzy/capabilities" data-nav="capabilities">Capabilities</a>',
    '<a href="/buzzy/memory" data-nav="memory">Memory</a>',
    '<a href="/buzzy/experts" data-nav="experts">Experts</a>',
    '<a href="/buzzy/recipes" data-nav="recipes">Recipes</a>',
    '<a href="/buzzy/wallet" data-nav="wallet">Honey Drops</a>',
    '<a href="/buzzy/upload" data-nav="publish">Publish</a>',
    '<a href="/buzzy/landing" class="account-link" id="accountLink">Sign in</a>',
  ].join("\n      ");

  let page = body.toString("utf8");
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
  return out(page);
});
