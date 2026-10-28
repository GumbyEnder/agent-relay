#!/usr/bin/env node
/**
 * S3b: replace the inline chat-turn body in `chat.nitro.ts` with a call to
 * `runChatTurn` in `src/lib/buzzy/turn.ts`.
 *
 * The moved text already lives in turn.ts; this only rewrites the handler into
 * a transport shim (auth + body parse + outcome mapping). Idempotent.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NITRO = join(ROOT, "src/lib/buzzy/chat.nitro.ts");

const src = readFileSync(NITRO, "utf8");
if (src.includes("runChatTurn")) {
  console.log("already shimmed — no change");
  process.exit(0);
}
const lines = src.split("\n");

const routeIdx = lines.findIndex((l) => l.includes('path === "/api/buzzy/chat"'));
if (routeIdx === -1) throw new Error("chat route not found");

const startIdx = lines.findIndex(
  (l, i) => i > routeIdx && l.includes("const jobId: string | null = typeof body.jobId"),
);
if (startIdx === -1) throw new Error("chat turn body not found");

const endIdx = lines.findIndex((l, i) => i > startIdx && l === "    return result;");
if (endIdx === -1) throw new Error("chat turn end not found");

const shim = [
  "    const turn = await runChatTurn({ userId, body });",
  "    if (turn.kind === \"stream\") return turn.response;",
  "    if (turn.status !== 200) setResponseStatus(event, turn.status);",
  "    return turn.payload;",
];

const out = [...lines.slice(0, startIdx), ...shim, ...lines.slice(endIdx + 1)];

// Import at the end of the local module import block.
const anchor = out.findIndex((l) => l.includes('from "./companyContext"') || l.includes('from "./companyContext";'));
if (anchor === -1) throw new Error("import anchor not found");
let insertAt = anchor;
while (out[insertAt] !== undefined && !out[insertAt].includes('from "./')) insertAt++;
out.splice(insertAt + 1, 0, 'import { runChatTurn } from "./turn";');

const finalSrc = out.join("\n");
writeFileSync(NITRO, finalSrc);
console.log(
  `shimmed chat handler: removed ${endIdx - startIdx + 1} lines, chat.nitro.ts now ${finalSrc.split("\n").length} lines`,
);
