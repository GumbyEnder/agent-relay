/**
 * Pin-file resolution for the CLI.
 *
 * Mirrors `src/lib/recipe-seal/trust.ts` (env, then the shipped publishers.json).
 * Kept deliberately small: the CLI reports what a build trusts, but it never
 * decides whether a bundle is trusted — that answer comes from the runtime, so
 * there is exactly one implementation of the verification rule.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function pinFileCandidates(root, cwd = process.cwd()) {
  const explicit = (process.env.BZ_RECIPE_PUBLISHER_FILE ?? "").trim();
  if (explicit) return [explicit];
  return [join(cwd, "publishers.json"), join(root, "publishers.json"), join(cwd, "..", "publishers.json")];
}

export function readPins(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed?.publishers)) return [];
    return parsed.publishers
      .map((p) => ({ keyId: String(p?.keyId ?? ""), publicKey: String(p?.publicKey ?? "").trim() }))
      .filter((p) => p.publicKey);
  } catch {
    return [];
  }
}

/** Effective pin count + where they came from (env wins). */
export function resolvePins(root) {
  const env = (process.env.BZ_RECIPE_PUBLISHER_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (env.length > 0) return { count: env.length, source: "env" };

  for (const file of pinFileCandidates(root)) {
    if (!existsSync(file)) continue;
    const pins = readPins(file);
    if (pins.length > 0) return { count: pins.length, source: file };
  }
  return { count: 0, source: "none" };
}
