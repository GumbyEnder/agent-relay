/**
 * What a model actually costs, from the gateway's own /models payload.
 *
 * The catalog in BZ_CHAT_MODELS rarely carries prices, so a run's cost column
 * read $0.0000 — which is not "free", it is "unknown", and those are different
 * claims. The gateway publishes per-token prices for every model it serves, so
 * we read them from there instead of asking an operator to retype them.
 *
 * Cached for ten minutes in memory: prices do not change per request, and a run
 * must not pay a network round trip per node.
 */

const BASE_URL = process.env.BZ_CHAT_BASE_URL || "https://inference-api.nousresearch.com/v1";
const API_KEY = process.env.BZ_CHAT_KEY;

export interface ModelPrice {
  /** USD per single prompt token. */
  prompt: number;
  /** USD per single completion token. */
  completion: number;
  onFrontier: boolean;
  contextLength: number | null;
}

let _prices: Map<string, ModelPrice> | null = null;
let _fetchedAt = 0;
const TTL_MS = 10 * 60 * 1000;

interface RawModel {
  id?: string;
  pricing?: { prompt?: string | number; completion?: string | number };
  frontier?: boolean | null;
  context_length?: number | null;
}

async function load(force = false): Promise<Map<string, ModelPrice>> {
  if (!force && _prices && Date.now() - _fetchedAt < TTL_MS) return _prices;
  const map = new Map<string, ModelPrice>();
  try {
    const res = await fetch(`${BASE_URL.replace(/\/+$/, "")}/models`, {
      headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`models ${res.status}`);
    const body = (await res.json()) as { data?: RawModel[] };
    for (const m of body.data || []) {
      if (!m.id) continue;
      const prompt = Number(m.pricing?.prompt);
      const completion = Number(m.pricing?.completion);
      map.set(m.id, {
        prompt: Number.isFinite(prompt) ? prompt : 0,
        completion: Number.isFinite(completion) ? completion : 0,
        onFrontier: m.frontier === true,
        contextLength: m.context_length ?? null,
      });
    }
  } catch {
    // Unknown prices must never break a run; they only leave cost at 0 and
    // `priced:false` so the reader knows the number is missing, not zero.
    return _prices || map;
  }
  _prices = map;
  _fetchedAt = Date.now();
  return map;
}

/** Cost of one call in USD, or null when the gateway did not publish a price. */
export async function costOf(model: string, promptTokens: number, completionTokens: number): Promise<number | null> {
  const prices = await load();
  const p = prices.get(model);
  if (!p || (!p.prompt && !p.completion)) return null;
  return promptTokens * p.prompt + completionTokens * p.completion;
}

/** Models the operator marks as sitting on the frontier — real data, not a guess. */
export async function frontierModels(): Promise<string[]> {
  const prices = await load();
  return [...prices.entries()].filter(([, p]) => p.onFrontier).map(([id]) => id);
}

export async function priceTable(): Promise<Array<{ model: string; promptPerMTok: number; completionPerMTok: number; onFrontier: boolean }>> {
  const prices = await load();
  return [...prices.entries()]
    .map(([model, p]) => ({
      model,
      promptPerMTok: +(p.prompt * 1e6).toFixed(4),
      completionPerMTok: +(p.completion * 1e6).toFixed(4),
      onFrontier: p.onFrontier,
    }))
    .sort((a, b) => a.model.localeCompare(b.model));
}
