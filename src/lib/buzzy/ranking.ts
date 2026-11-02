import { priceTable, frontierModels } from "./pricing";

/**
 * Build the cached ranking from evidence we actually have.
 *
 * What we have: the gateway's per-token prices and its own `frontier` flag.
 * What we do not have: a per-category leaderboard. So a category is a *filter*
 * (a heuristic over the model id) and the order inside it is:
 *
 *   1. frontier-flagged models first,
 *   2. then by completion price, descending.
 *
 * Step 2 is a documented proxy — a bigger model usually costs more per token —
 * and it is a proxy, not a benchmark. The point of this file is that the ranking
 * is *derived and reproducible* instead of hand-picked, so widening the catalog
 * widens the frontier automatically.
 *
 * Models this deployment cannot call are excluded: a ranking full of models we
 * cannot reach turns every pin into a substitution.
 */

export interface RankedEntry {
  model: string;
  family: string;
  provider: string;
  onFrontier: boolean;
}

export interface BuiltRanking {
  as_of: string;
  source: string;
  note: string;
  categories: Record<string, RankedEntry[]>;
  /** Everything reachable, so a caller can offer "any model" too. */
  all: RankedEntry[];
}

const CATEGORY_HINTS: Array<[string, RegExp]> = [
  ["coding", /(code|coder|codestral|devstral|swe|opus-4|sonnet-5|k2\.7-code)/i],
  ["reasoning", /(thinking|reason|r1|o3|o4|pro-0|ultra|deep-research)/i],
  ["fast", /(flash|mini|nano|lite|small|air|haiku|instant|turbo)/i],
  ["vision", /(vl|vision|image|multimodal)/i],
];

export function familyOf(model: string): string {
  const tail = model.split("/")[1] || model;
  return tail.split(/[-:_]/)[0] || tail;
}

export function categoryOf(model: string): string {
  for (const [name, re] of CATEGORY_HINTS) if (re.test(model)) return name;
  return "general";
}

export async function buildRanking(reachable: string[]): Promise<BuiltRanking> {
  const prices = await priceTable();
  const byModel = new Map(prices.map((p) => [p.model, p]));
  const frontier = new Set(await frontierModels());
  const usable = reachable.length ? reachable : prices.map((p) => p.model);

  const entries: RankedEntry[] = usable.map((model) => ({
    model,
    family: familyOf(model),
    provider: model.includes("/") ? model.split("/")[0]! : "unknown",
    onFrontier: frontier.has(model),
  }));

  const rank = (a: RankedEntry, b: RankedEntry): number => {
    if (a.onFrontier !== b.onFrontier) return a.onFrontier ? -1 : 1;
    const ap = byModel.get(a.model)?.completionPerMTok ?? 0;
    const bp = byModel.get(b.model)?.completionPerMTok ?? 0;
    if (ap !== bp) return bp - ap; // bigger/stronger first, as a documented proxy
    return a.model.localeCompare(b.model);
  };

  const categories: Record<string, RankedEntry[]> = {};
  for (const e of entries) {
    const c = categoryOf(e.model);
    (categories[c] ||= []).push(e);
  }
  for (const list of Object.values(categories)) list.sort(rank);
  entries.sort(rank);

  const frontierCount = entries.filter((e) => e.onFrontier).length;
  return {
    as_of: new Date().toISOString().slice(0, 10),
    source: "frontier+price",
    note:
      `Derived from the gateway's frontier flag and published prices over the ${entries.length} models this deployment can call ` +
      `(${frontierCount} frontier-flagged). Order inside a category: frontier first, then completion price descending — a documented proxy, not a benchmark. ` +
      `Category is a heuristic over the model id.`,
    categories,
    all: entries,
  };
}
