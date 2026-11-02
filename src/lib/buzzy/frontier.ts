import snapshot from "./frontier.json";
import { getSql } from "@/lib/db";

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

const BUNDLED = snapshot as Snapshot;

/**
 * The live ranking: the database row if one has been refreshed, otherwise the
 * bundled file. Memoised for a minute so a graph run does not hit the database
 * once per node, and so a refresh is visible within a minute without a deploy.
 */
let _cached: { at: number; snap: Snapshot } | null = null;
const SNAP_TTL_MS = 60_000;

export async function getSnapshot(force = false): Promise<Snapshot> {
  if (!force && _cached && Date.now() - _cached.at < SNAP_TTL_MS) return _cached.snap;
  let snap: Snapshot = BUNDLED;
  try {
    const sql = await getSql();
    const rows = await sql<{ payload: Snapshot; source: string; as_of: string }>`
      SELECT payload, source, to_char(as_of, 'YYYY-MM-DD') AS as_of FROM buzzy_frontier WHERE id = 'current' LIMIT 1
    `;
    if (rows.length) {
      const r = rows[0]!;
      snap = { ...r.payload, source: r.source, as_of: r.as_of };
    }
  } catch {
    // No table yet (pre-migration) or the database is unreachable: the bundled
    // ranking is a valid answer, and a run should not die because of telemetry.
    snap = BUNDLED;
  }
  _cached = { at: Date.now(), snap };
  return snap;
}

/** Store a refreshed ranking. Called out of band, never during a run. */
export async function saveSnapshot(payload: Snapshot, source: string, note?: string): Promise<void> {
  const sql = await getSql();
  await sql`
    INSERT INTO buzzy_frontier (id, payload, source, as_of, note, updated_at)
    VALUES ('current', ${JSON.stringify(payload)}::jsonb, ${source}, now(), ${note ?? null}, now())
    ON CONFLICT (id) DO UPDATE SET
      payload = EXCLUDED.payload, source = EXCLUDED.source, as_of = now(),
      note = EXCLUDED.note, updated_at = now()
  `;
  _cached = null;
}

/** Reject a ranking that would make a graph unresolvable in silence. */
export function validateSnapshot(input: unknown): { ok: true; snap: Snapshot } | { ok: false; error: string } {
  const raw = input as Partial<Snapshot> | null;
  if (!raw || typeof raw !== "object" || !raw.categories || typeof raw.categories !== "object") {
    return { ok: false, error: "Send { categories: { name: [{ model, family, provider }] } }." };
  }
  const categories: Record<string, FrontierEntry[]> = {};
  for (const [name, list] of Object.entries(raw.categories)) {
    if (!Array.isArray(list) || !list.length) return { ok: false, error: `Category "${name}" is empty.` };
    const entries: FrontierEntry[] = [];
    for (const e of list) {
      const entry = e as FrontierEntry;
      if (!entry || typeof entry.model !== "string" || !entry.model) return { ok: false, error: `An entry in "${name}" has no model.` };
      entries.push({
        model: entry.model,
        family: String(entry.family || entry.model.split("/")[1]?.split("-")[0] || "unknown"),
        provider: String(entry.provider || (entry.model.includes("/") ? entry.model.split("/")[0] : "unknown")),
      });
    }
    categories[name] = entries;
  }
  return {
    ok: true,
    snap: {
      as_of: new Date().toISOString().slice(0, 10),
      source: String(raw.source || "refreshed"),
      note: String(raw.note || "refreshed out of band"),
      categories,
    },
  };
}

const SNAP = BUNDLED;

export function frontierAsOf(snap: Snapshot = SNAP): { as_of: string; source: string; categories: string[] } {
  return { as_of: snap.as_of, source: snap.source, categories: Object.keys(snap.categories) };
}

export async function frontierAsOfLive(): Promise<{ as_of: string; source: string; categories: string[] }> {
  return frontierAsOf(await getSnapshot());
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
export function resolvePin(pin: ModelPin, catalog: string[] = [], avoidProvider?: string, snap: Snapshot = SNAP): Resolution {
  if (pin.mode === "exact") {
    const provider = providerOf(pin.model);
    return {
      model: pin.model, provider, family: "exact", position: null,
      substituted: false, reason: "pinned exactly", as_of: snap.as_of,
    };
  }

  if (pin.mode === "latest") {
    const family = pin.family.toLowerCase();
    const entries = Object.values(snap.categories).flat().filter((e) => e.family === family);
    const pick = entries.find((e) => available(e, catalog) && (!avoidProvider || e.provider !== avoidProvider));
    if (pick) {
      return {
        model: pick.model, provider: pick.provider, family: pick.family, position: null,
        substituted: false, reason: `latest ${family} in the cached ranking`, as_of: snap.as_of,
      };
    }
    const anyFamily = catalog.find((m) => m.toLowerCase().includes(family));
    if (anyFamily) {
      return {
        model: anyFamily, provider: providerOf(anyFamily), family, position: null,
        substituted: true, reason: `family ${family} not in the cached ranking; took the catalog match`, as_of: snap.as_of,
      };
    }
    throw new Error(`No model available for family "${pin.family}".`);
  }

  const ranking = snap.categories[pin.category];
  if (!ranking || !ranking.length) {
    throw new Error(`Unknown frontier category "${pin.category}". Known: ${Object.keys(snap.categories).join(", ")}.`);
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
      as_of: snap.as_of,
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
      as_of: snap.as_of,
    };
  }

  throw new Error(`Nothing in the ${pin.category} frontier is reachable from this deployment.`);
}

/** Convenience for a review node: same frontier position, different provider. */
export function resolveReview(producerModel: string, category: string, position: number, catalog: string[] = [], snap: Snapshot = SNAP): Resolution {
  return resolvePin({ mode: "frontier", category, position }, catalog, providerOf(producerModel), snap);
}

/** Live variants: read the current ranking (database first) instead of the bundled file. */
export async function resolvePinLive(pin: ModelPin, catalog: string[] = [], avoidProvider?: string): Promise<Resolution> {
  return resolvePin(pin, catalog, avoidProvider, await getSnapshot());
}

export async function resolveReviewLive(producerModel: string, category: string, position: number, catalog: string[] = []): Promise<Resolution> {
  return resolveReview(producerModel, category, position, catalog, await getSnapshot());
}
