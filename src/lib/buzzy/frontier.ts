import snapshot from "./frontier.json";

/**
 * Model selection by *position on a frontier*, not by name.
 *
 * The point (his ask): a graph node should be able to say "the model in position
 * 3 of the writing frontier" or "latest of family gemini", so a graph keeps
 * meaning as models are replaced. Two rules keep this honest:
 *
 *  1. A run never touches the network. The ranking is a cached file; refreshing
 *     it is an out-of-band job (`refresh`), not something a run does.
 *  2. The resolution is checked against the models this deployment can actually
 *     reach. If the ranked model is unavailable we fall back to the nearest
 *     available entry *in the same category* and say `substituted: true` — a
 *     silent substitution would make a run unreproducible and its review fake.
 */

export interface FrontierEntry {
  model: string;
  family: string;
  provider: string;
}

export type ModelPin =
  | { mode: "latest"; family: string }
  | { mode: "frontier"; category: string; position: number }
  | { mode: "exact"; model: string };

export interface Resolution {
  model: string;
  provider: string;
  family: string;
  /** Position (1-based) this model occupies in its category, when known. */
  position: number | null;
  substituted: boolean;
  reason: string;
  as_of: string;
}

interface Snapshot {
  as_of: string;
  source: string;
  note: string;
  categories: Record<string, FrontierEntry[]>;
}

const SNAP = snapshot as Snapshot;

export function frontierAsOf(): { as_of: string; source: string; categories: string[] } {
  return { as_of: SNAP.as_of, source: SNAP.source, categories: Object.keys(SNAP.categories) };
}

export function providerOf(model: string): string {
  const hit = Object.values(SNAP.categories).flat().find((e) => e.model === model);
  if (hit) return hit.provider;
  // Providers are namespaced in the gateway ("google/…", "x-ai/…").
  return model.includes("/") ? model.split("/")[0]! : "unknown";
}

function available(entry: FrontierEntry, catalog: string[]): boolean {
  if (!catalog.length) return true; // catalog unreachable: trust the cache rather than refuse to run
  return catalog.includes(entry.model);
}

/**
 * Resolve one pin. `catalog` is the live model list; empty means "unknown".
 * `avoidProvider` makes the choice independent (6c): a review node passes the
 * provider of the node it checks and gets a genuinely different one.
 */
export function resolvePin(pin: ModelPin, catalog: string[] = [], avoidProvider?: string): Resolution {
  if (pin.mode === "exact") {
    const provider = providerOf(pin.model);
    return {
      model: pin.model, provider, family: "exact", position: null,
      substituted: false, reason: "pinned exactly", as_of: SNAP.as_of,
    };
  }

  if (pin.mode === "latest") {
    const family = pin.family.toLowerCase();
    const entries = Object.values(SNAP.categories).flat().filter((e) => e.family === family);
    const pick = entries.find((e) => available(e, catalog) && (!avoidProvider || e.provider !== avoidProvider));
    if (pick) {
      return {
        model: pick.model, provider: pick.provider, family: pick.family, position: null,
        substituted: false, reason: `latest ${family} in the cached ranking`, as_of: SNAP.as_of,
      };
    }
    const anyFamily = catalog.find((m) => m.toLowerCase().includes(family));
    if (anyFamily) {
      return {
        model: anyFamily, provider: providerOf(anyFamily), family, position: null,
        substituted: true, reason: `family ${family} not in the cached ranking; took the catalog match`, as_of: SNAP.as_of,
      };
    }
    throw new Error(`No model available for family "${pin.family}".`);
  }

  const ranking = SNAP.categories[pin.category];
  if (!ranking || !ranking.length) {
    throw new Error(`Unknown frontier category "${pin.category}". Known: ${Object.keys(SNAP.categories).join(", ")}.`);
  }
  const asked = Math.max(1, pin.position | 0);
  const wanted = Math.min(asked, ranking.length);
  const order = avoidProvider
    ? [...ranking.filter((e) => e.provider !== avoidProvider), ...ranking.filter((e) => e.provider === avoidProvider)]
    : ranking;

  const exactHit = order[wanted - 1];
  if (exactHit && available(exactHit, catalog)) {
    const independent = !avoidProvider || exactHit.provider !== avoidProvider;
    return {
      model: exactHit.model, provider: exactHit.provider, family: exactHit.family, position: wanted,
      // Clamping is a substitution of intent and must say so: asking for
      // position 99 and silently getting the last one would read as position 99.
      substituted: asked !== wanted,
      reason: asked !== wanted
        ? `${pin.category} has ${ranking.length} models; asked for position ${asked}, took ${wanted}`
        : independent
          ? `position ${wanted} on ${pin.category}`
          : `position ${wanted} on ${pin.category} — same provider as the node it reviews`,
      as_of: SNAP.as_of,
    };
  }

  // Ranked model is unavailable: take the nearest available position, and say so.
  const fallbackIdx = order.findIndex((e) => available(e, catalog) && (!avoidProvider || e.provider !== avoidProvider));
  if (fallbackIdx >= 0) {
    const fb = order[fallbackIdx]!;
    return {
      model: fb.model, provider: fb.provider, family: fb.family, position: fallbackIdx + 1,
      substituted: true,
      reason: `position ${wanted} of ${pin.category} is not reachable; nearest available is position ${fallbackIdx + 1}`,
      as_of: SNAP.as_of,
    };
  }

  throw new Error(`Nothing in the ${pin.category} frontier is reachable from this deployment.`);
}

/** Convenience for a review node: same frontier position, different provider. */
export function resolveReview(producerModel: string, category: string, position: number, catalog: string[] = []): Resolution {
  return resolvePin({ mode: "frontier", category, position }, catalog, providerOf(producerModel));
}
