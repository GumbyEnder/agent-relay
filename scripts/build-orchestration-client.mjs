/**
 * Bundle the orchestration spec module for the browser.
 *
 * public/buzzy/orchestrate.html is a static page served by pages.nitro.ts, not a
 * Vite entry, so it cannot import src/lib/buzzy/orchestration.ts. This emits that
 * one module as an IIFE exposing window.BZOrchestration, which keeps the page's
 * validator the same code the server runs — not a second copy that drifts.
 *
 * Runs from `prebuild`, before `vite build` copies public/ into .output/public.
 * In dev, run it once (or `npm run build:orch-client`) after editing the module.
 *
 *   node scripts/build-orchestration-client.mjs
 */
import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir("public/buzzy", { recursive: true });
await build({
  entryPoints: ["src/lib/buzzy/orchestration.ts"],
  outfile: "public/buzzy/orchestration.js",
  bundle: true,
  format: "iife",
  globalName: "BZOrchestration",
  platform: "browser",
  target: ["es2020"],
  minify: false,
  charset: "utf8",
  banner: {
    js: "/* Generated from src/lib/buzzy/orchestration.ts by scripts/build-orchestration-client.mjs. Do not edit. */",
  },
});
console.log("public/buzzy/orchestration.js written");
