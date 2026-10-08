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

const PAGES = new Set(["index", "talk", "memory", "remember", "form", "experts", "library"]);

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

  const path = (event.path ?? "").replace(/\/+$/, "") || "/buzzy";
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
  return html(body.toString("utf8"));
});
