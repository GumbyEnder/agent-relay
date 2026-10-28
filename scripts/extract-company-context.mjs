#!/usr/bin/env node
/**
 * One-off S3 prep: move the company-context helpers out of `chat.nitro.ts`
 * into `src/lib/buzzy/companyContext.ts`.
 *
 * Why: `runChatTurn` cannot be extracted while its helpers live inside the
 * 3.8k-line Nitro handler — a module that imports from a handler that imports
 * the module is a cycle. Doing the helper move first keeps each step tsc-clean.
 *
 * The script is idempotent: if the slice is already gone it does nothing.
 * Run once: node scripts/extract-company-context.mjs && npx tsc --noEmit
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NITRO = join(ROOT, "src/lib/buzzy/chat.nitro.ts");
const OUT = join(ROOT, "src/lib/buzzy/companyContext.ts");

const src = readFileSync(NITRO, "utf8");
const lines = src.split("\n");

const startIdx = lines.findIndex((l) => l.startsWith("function isCompanyId("));
if (startIdx === -1) {
  console.log("already extracted — no slice found");
  process.exit(0);
}
const factsIdx = lines.findIndex((l) => l.startsWith("async function companyFacts("));
if (factsIdx === -1) throw new Error("companyFacts not found");

// Slice runs from isCompanyId to the closing brace of companyFacts.
let endIdx = factsIdx;
while (endIdx < lines.length && lines[endIdx] !== "}") endIdx++;
endIdx += 1; // include the closing brace line

const slice = lines.slice(startIdx, endIdx);

const body = slice
  .map((l) =>
    l.startsWith("function ") || l.startsWith("async function ")
      ? l.replace(/^function /, "export function ").replace(/^async function /, "export async function ")
      : l.startsWith("type ")
        ? l.replace(/^type /, "export type ")
        : l.startsWith("const ")
          ? l.replace(/^const /, "export const ")
          : l,
  )
  .join("\n");

const header = `/**
 * Company context for the chat turn.
 *
 * Extracted from \`chat.nitro.ts\` so the orchestrator can be lifted out of the
 * Nitro handler without importing it (that would be a cycle). Pure data access
 * over \`buzzy_companies\` / \`buzzy_company_facts\` — no transport, no auth.
 */
import type { Sql } from "./db";
import type { MoneyBriefLine } from "./money";

`;

writeFileSync(OUT, header + body + "\n");

const before = lines.slice(0, startIdx);
const after = lines.slice(endIdx);
const rel = (before.length ? before.join("\n") + "\n" : "") + after.join("\n");

// Import back where the handler's own import block already lives.
const importLine =
  'import { isCompanyId, asMoneyBrief, companyName, linePayload, companyPayload, factValue, confirmedCompanyContext, companyFacts } from "./companyContext";\n';
const moneyImport = rel.indexOf('from "./money"');
const insertAt = rel.indexOf("\n", moneyImport) + 1;
const finalSrc = rel.slice(0, insertAt) + importLine + rel.slice(insertAt);

writeFileSync(NITRO, finalSrc);
console.log(
  `extracted ${slice.length} lines → src/lib/buzzy/companyContext.ts (chat.nitro.ts now ${finalSrc.split("\n").length} lines)`,
);
