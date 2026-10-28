#!/usr/bin/env node
/**
 * Regenerate src/lib/recipe-seal/confusables.ts from the Unicode confusables data.
 *
 *   node scripts/build-confusables.mjs
 *
 * Reads the published UTS #39 file, keeps only mappings whose source is a single
 * non-ASCII code point and whose target is an ASCII letter or digit, drops
 * anything NFKC already folds to the same target, and writes the compact table.
 *
 * The table is DATA and must stay regenerable. A hand-curated list of lookalikes
 * is the heuristic trap the leak gate spent thirteen review rounds escaping.
 */
import { writeFileSync } from "node:fs";

const SOURCE_URL = "https://www.unicode.org/Public/security/latest/confusables.txt";

const res = await fetch(SOURCE_URL);
if (!res.ok) {
  console.error(`fetch failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const text = await res.text();

const pairs = new Map();
for (const rawLine of text.split("\n")) {
  const line = rawLine.split("#")[0].trim();
  if (!line) continue;
  const parts = line.split(";").map((p) => p.trim());
  if (parts.length < 2) continue;
  let source;
  let target;
  try {
    source = String.fromCodePoint(parseInt(parts[0], 16));
    target = parts[1].split(/\s+/).map((h) => String.fromCodePoint(parseInt(h, 16))).join("");
  } catch {
    continue;
  }
  if ([...source].length !== 1 || !target) continue;
  if (!/^[0-9a-z]$/i.test(target)) continue;
  if (source.codePointAt(0) < 0x80) continue;
  // Anything NFKC already folds to the same target needs no entry here.
  if (source.normalize("NFKC").toLowerCase() === target) continue;
  pairs.set(source, target);
}

const encoded = [...pairs.entries()]
  .sort(([a], [b]) => a.codePointAt(0) - b.codePointAt(0))
  .map(([k, v]) => `${k.codePointAt(0).toString(16)}>${v}`)
  .join(";");

const header = `/**
 * Unicode confusables (UTS #39), reduced to what this gate needs.
 *
 * Generated from ${SOURCE_URL} — do not hand-edit. Regenerate with
 * \`node scripts/build-confusables.mjs\`.
 *
 * Only single non-ASCII source code points mapping to an ASCII letter/digit are
 * kept, minus anything NFKC already folds to the same target: ${pairs.size} entries.
 *
 * Why this exists: a sealed half written with Cyrillic lookalikes ("n\u0435v\u0435r quot\u0435s") published against a
 * Latin manifest with the gate clean. Exact comparison cannot see that; identity of
 * characters is a different question from boundaries of comparison.
 */

/** \`hexcode>ascii;hexcode>ascii;\u2026\` */
const ENCODED = "${encoded}";

const MAP = (() => {
  const m = new Map<number, string>();
  for (const pair of ENCODED.split(";")) {
    if (!pair) continue;
    const [hex, target] = pair.split(">");
    if (!hex || !target) continue;
    m.set(parseInt(hex, 16), target);
  }
  return m;
})();

/** Fold code points that merely LOOK like ASCII into the ASCII they imitate. */
export function foldConfusables(s: string): string {
  if (!/[^\\x00-\\x7F]/.test(s)) return s;
  let out = "";
  for (const ch of s) {
    const mapped = MAP.get(ch.codePointAt(0)!);
    out += mapped ?? ch;
  }
  return out;
}

export const CONFUSABLE_COUNT = MAP.size;
`;

writeFileSync(new URL("../src/lib/recipe-seal/confusables.ts", import.meta.url), header);
console.log(`wrote ${pairs.size} confusable mappings`);
