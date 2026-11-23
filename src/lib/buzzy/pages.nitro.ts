/**
 * Nitro handler for extension-less /buzzy/* pages.
 *
 * GET /buzzy        → public/buzzy/index.html
 * GET /buzzy/talk   → public/buzzy/talk.html
 * GET /buzzy/memory → public/buzzy/memory.html
 *
 * Path is sanitized (no traversal); only known pages are served.
 */

import { defineEventHandler, getMethod, setResponseStatus } from "h3";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Every name here must have a file in public/buzzy — "form" was listed with no
  // form.html behind it, so /buzzy/form answered 404 from a route that claimed
  // to serve it.
// "settings" is desktop-only: the Electron shell lowers the Settings window
// through this route so it stops depending on a static .html fallback.
const PAGES = new Set(["index", "talk", "memory", "remember", "experts", "library", "profile", "landing", "recipes", "wallet", "upload", "graph", "settings", "capabilities", "sketch"]);

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

export default defineEventHandler(async (event) => {
  if (getMethod(event) !== "GET") {
    setResponseStatus(event, 405);
    return { error: "method not allowed" };
  }

  // event.path includes the query string in this runtime. Strip it before
  // matching or /buzzy/talk?job=… is not a known page.
  const path = (event.path ?? "").split("?")[0].replace(/\/+$/, "") || "/buzzy";
  const segments = path.split("/").filter(Boolean); // ["buzzy", maybe "talk"]

  let name: string;
  if (segments.length === 1) {
    name = "index";
  } else if (segments.length === 2) {
    name = segments[1];
  } else {
    setResponseStatus(event, 404);
    return html("<h1>Not found</h1>", 404);
  }

  if (name.includes("/") || name.includes("\\")) {
    setResponseStatus(event, 404);
    return html("<h1>Not found</h1>", 404);
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
      return html("<h1>Not found</h1>", 404);
    }
    const rel = segments.slice(1).join("/");
    const data = await readBuzzyFile(rel);
    if (!data) {
      setResponseStatus(event, 404);
      return html("<h1>Not found</h1>", 404);
    }
    return new Response(new Uint8Array(data), {
      headers: { "content-type": mime },
    });
  }

  if (!PAGES.has(name)) {
    setResponseStatus(event, 404);
    return html("<h1>Not found</h1>", 404);
  }

  // /buzzy/library is the Library (documents vault) view of the app shell —
  // same index.html, which opens the docs screen when the URL ends in /library.
  // The root /buzzy/* is the consolidated Work interface: index.html itself
  // redirects non-library routes to talk.html.
  const fileName = name === "library" ? "index" : name;

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
    return html("<h1>Not found</h1>", 404);
  }
  // CR-8: one chrome, the same one the website ships. The desktop used to hand-write
  // its own <nav> into every page and it drifted from web main — different order
  // (Capabilities before Sketch), different words ("Capabilities", "Honey Drops"),
  // Library still opening a new tab, and a literal "Sign in" for signed-in readers.
  // web main fixed that by writing the row ONCE in pages.nitro.ts and letting
  // nav.js own state; this is the same seam, copied rather than re-derived, so the
  // two release lines cannot describe two different products.
  const NAV_ROW = [
    '<a href="/buzzy/talk" data-nav="talk">Talk</a>',
    '<a href="/buzzy/library" data-nav="library">Library</a>',
    '<a href="/buzzy/memory" data-nav="memory">Memory</a>',
    '<a href="/buzzy/experts" data-nav="experts">Experts</a>',
    '<a href="/buzzy/recipes" data-nav="recipes">Recipes</a>',
    '<a href="/buzzy/sketch" data-nav="sketch">Sketch</a>',
    '<a href="/buzzy/studio" data-nav="studio">Music studio</a>',
    '<a href="/buzzy/capabilities" data-nav="capabilities">What BeeZilla can do</a>',
    '<a href="/buzzy/download" data-nav="download">Download</a>',
    '<a href="/buzzy/wallet" data-nav="wallet">Honey</a>',
    '<a href="/buzzy/upload" data-nav="publish">Publish</a>',
    // Blank on purpose: the row cannot know who is signed in, and the word "Sign in"
    // over a real name is a lie. nav.js paints the cached identity, then the truth.
    '<a href="/buzzy/landing" class="account-link" id="accountLink" aria-label="Account"></a>',
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
  if (!page.includes("/buzzy/nav.css")) {
    const at = page.lastIndexOf("</head>");
    if (at > 0) {
      page = page.slice(0, at) + '<link rel="stylesheet" href="/buzzy/nav.css" />' + page.slice(at);
    }
  }
  return html(page);
});
