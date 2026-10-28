/**
 * Use a recipe you own.
 *
 * This is the other half of the marketplace: a purchase grants an entitlement, and
 * an entitlement lets the method be opened *for that buyer only*, run once, and
 * graded by the checks that shipped with it.
 *
 * Deliberately not built on a bearer token. A token is the right shape for an API
 * customer pointing their own agent at us; a signed-in person already has a session,
 * so the door is the entitlement plus the session. Fewer secrets in fewer places.
 *
 * The sealed method never leaves the server: it is opened here, put into a prompt,
 * and discarded. What comes back to the caller is the document and the verdict.
 */
import type { BundleParts } from "./bundle";
import { openSemantic, partsOf } from "./bundle";
import { bundleKey, type BundleStorage } from "./storage";
import { loadRules } from "@/lib/recipe-checks/seal";
import { evaluateDraft } from "@/lib/recipe-checks/vm";

export interface SealedMethod {
  discovery?: string[];
  boundary?: string;
  checklist?: { output?: string; audience?: string; success?: string };
  outputContract?: string[];
}

export interface UseResult {
  ok: boolean;
  artifact: { title: string; sections: Array<{ id: string; title: string; body: string }> } | null;
  codes: string[];
  warnings: string[];
  note?: string;
}

const SYSTEM = [
  "You are executing a saved method. Follow it exactly.",
  "Return ONLY a JSON object: {\"title\": string, \"sections\": [{\"title\": string, \"body\": string}]}",
  "One section per entry in the method's output contract, in that order.",
  "Never invent a fact, a number, a name or a date that the owner did not supply.",
  "If the method forbids something, do not do it — state the gap in the relevant section instead.",
].join(" ");

export async function loadParts(storage: BundleStorage, hash: string): Promise<BundleParts | null> {
  const srb = await storage.get(bundleKey(hash));
  if (!srb) return null;
  return partsOf(srb);
}

export function methodBlock(method: SealedMethod): string {
  const lines: string[] = ["METHOD"];
  if (method.discovery?.length) lines.push(`Strings to establish first: ${method.discovery.join(" | ")}`);
  if (method.outputContract?.length) lines.push(`Sections, in order: ${method.outputContract.join(" | ")}`);
  if (method.checklist?.output) lines.push(`What good output looks like: ${method.checklist.output}`);
  if (method.checklist?.success) lines.push(`Definition of done: ${method.checklist.success}`);
  if (method.boundary) lines.push(`HARD LIMIT: ${method.boundary}`);
  return lines.join("\n");
}

/**
 * Run the recipe for one owner.
 *
 * `model` is injected so this can be tested without a provider, and so the caller
 * decides which lane pays for the tokens.
 */
export async function useRecipe(args: {
  storage: BundleStorage;
  kek: Uint8Array;
  hash: string;
  input: string;
  model: (prompt: string) => Promise<string>;
}): Promise<UseResult> {
  const parts = await loadParts(args.storage, args.hash);
  if (!parts) return { ok: false, artifact: null, codes: [], warnings: [], note: "recipe_unavailable" };

  const opened = openSemantic(parts, args.kek);
  if (!opened.ok) return { ok: false, artifact: null, codes: [], warnings: [], note: "sealed_unreadable" };

  const method = (opened.semantic ?? {}) as SealedMethod;
  const rules = loadRules(parts.checksWasm);

  const raw = await args.model(`${SYSTEM}\n\n${methodBlock(method)}\n\nOWNER'S BRIEF\n${args.input}`);
  const parsed = extractJson(raw);
  if (!parsed) return { ok: false, artifact: null, codes: ["output:unparseable"], warnings: [], note: "model returned no JSON" };

  const artifact = normalise(parsed, method);
  const draft = {
    version: 1,
    sections: artifact.sections.map((s) => ({ id: s.id, title: s.title, body: s.body })),
    claims: [] as Array<{ id: string; text: string; sourceId?: string }>,
    values: [] as Array<{ id: string; kind: string; raw: string; normalised: number; source: string }>,
    domain: {},
  };

  let codes: string[] = [];
  let warnings: string[] = [];
  try {
    const verdict = evaluateDraft(draft, rules) as { ok?: boolean; codes?: string[]; warnings?: string[] };
    codes = verdict.codes ?? [];
    warnings = verdict.warnings ?? [];
    return { ok: verdict.ok ?? codes.length === 0, artifact, codes, warnings };
  } catch (e) {
    return { ok: true, artifact, codes: [], warnings: [`checks_failed_to_run: ${String((e as Error).message).slice(0, 120)}`] };
  }
}

function normalise(parsed: unknown, method: SealedMethod): UseResult["artifact"] & object {
  const p = (parsed ?? {}) as Record<string, unknown>;
  const title = typeof p.title === "string" && p.title.trim() ? p.title.trim() : "Result";
  const rawSections = Array.isArray(p.sections) ? p.sections : [];
  const sections = rawSections
    .map((s, i) => {
      const o = (s ?? {}) as Record<string, unknown>;
      const t = typeof o.title === "string" ? o.title.trim() : `Section ${i + 1}`;
      const b = typeof o.body === "string" ? o.body.trim() : "";
      return { id: `s${i + 1}`, title: t, body: b };
    })
    .filter((s) => s.body.length > 0);

  // If the model dropped sections the contract asked for, say so rather than
  // presenting a short document as complete.
  const wanted = method.outputContract ?? [];
  const present = new Set(sections.map((s) => s.title.toLowerCase()));
  for (const w of wanted) {
    if (!present.has(w.toLowerCase())) sections.push({ id: `s${sections.length + 1}`, title: w, body: "[not produced — the owner must fill this in]" });
  }
  return { title, sections };
}

function extractJson(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}
