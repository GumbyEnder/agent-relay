/**
 * Buzzy information tools (plan doc 23, Phase 3) — the read-only family.
 *
 * All three are autonomous in-loop per the side-effect classification.
 * lookup_market_rate returns DISCLOSED RANGES from a deterministic table —
 * never invented precision. fetch_website wraps the existing SSRF-guarded
 * fetcher. search_knowledge reads the account's own confirmed facts only.
 * Fetched content is DATA, never instructions (prompt-injection defense).
 */

import { readPublicWebsite } from "./website";

/** JSON schema for lookup_market_rate. */
export const LOOKUP_MARKET_RATE_TOOL = {
  type: "function",
  function: {
    name: "lookup_market_rate",
    description:
      "Look up a typical market price RANGE for a service. Returns a low-high range " +
      "from a built-in rate table — a grounding reference, not an exact price. Use before " +
      "suggesting prices; present ranges as ranges, never as the owner's price.",
    parameters: {
      type: "object",
      properties: {
        service: { type: "string", description: "Service category, e.g. 'lawn care', 'hvac repair', 'house cleaning'." },
        unit: { type: "string", description: "Optional unit: 'hour', 'visit', 'sqft', 'job'." },
      },
      required: ["service"],
    },
  },
};

/** JSON schema for fetch_website. */
export const FETCH_WEBSITE_TOOL = {
  type: "function",
  function: {
    name: "fetch_website",
    description:
      "Read the public text of a web page (the owner's site, a supplier page). Returns " +
      "the page's visible text. Use for grounding a draft in real public information.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The page URL to read." },
      },
      required: ["url"],
    },
  },
};

/** JSON schema for search_knowledge. */
export const SEARCH_KNOWLEDGE_TOOL = {
  type: "function",
  function: {
    name: "search_knowledge",
    description:
      "Search the business's own confirmed records: company facts, confirmed document " +
      "facts, and remembered decisions. Use to check what is already known before asking " +
      "the owner to repeat it.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for, e.g. 'hourly rate', 'insurance'." },
      },
      required: ["query"],
    },
  },
};

// ── Rate table: deterministic ranges per category keyword ────────────────
// Ranges are deliberately wide and labelled as ranges. Grounded reference,
// not a price oracle; the owner's stated price always wins.
const RATE_TABLE: Array<{ match: RegExp; low: number; high: number; unit: string }> = [
  { match: /lawn|mow|grass|yard/i, low: 35, high: 80, unit: "visit" },
  { match: /hvac|ac |air condition|furnace/i, low: 90, high: 250, unit: "visit" },
  { match: /plumb|leak|pipe|drain/i, low: 100, high: 300, unit: "visit" },
  { match: /clean|maid|janitor/i, low: 30, high: 70, unit: "hour" },
  { match: /paint|painter/i, low: 25, high: 60, unit: "hour" },
  { match: /roof/i, low: 300, high: 1200, unit: "job" },
  { match: /snow|ice/i, low: 30, high: 100, unit: "visit" },
  { match: /handyman|repair|fix/i, low: 50, high: 125, unit: "hour" },
  { match: /electric|wiring/i, low: 90, high: 220, unit: "hour" },
  { match: /landscap|garden|mulch/i, low: 40, high: 150, unit: "visit" },
  { match: /tutor|lesson|instruct/i, low: 25, high: 80, unit: "hour" },
  { match: /photo|video/i, low: 75, high: 250, unit: "hour" },
  { match: /bookkeep|account|tax prep/i, low: 40, high: 150, unit: "hour" },
  { match: /dog|pet|walk|sit/i, low: 15, high: 50, unit: "visit" },
  { match: /move|moving|mover/i, low: 60, high: 150, unit: "hour" },
];

export interface MarketRate {
  service: string;
  unit: string;
  low: number;
  high: number;
  note: string;
}

export function lookupMarketRate(service: string, unit?: string): MarketRate {
  const row = RATE_TABLE.find((r) => r.match.test(service));
  if (!row) {
    return {
      service,
      unit: unit ?? "job",
      low: 40,
      high: 150,
      note: "No close match in the rate table — this is a generic service range. Treat it as a starting point only and ask the owner for their price.",
    };
  }
  return {
    service,
    unit: unit ?? row.unit,
    low: row.low,
    high: row.high,
    note: "Typical range from the built-in rate table. Present as a range; the owner's own price always wins.",
  };
}

/**
 * SSRF-guarded page fetch (wraps the existing readPublicWebsite), with the
 * prompt-injection frame: the result is returned as data-to-read, and the
 * loop's system prompt already establishes fetched content is never
 * instructions. Truncated to keep tool results bounded.
 */
export async function fetchWebsitePage(url: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) {
      return { ok: false, error: "only http(s) URLs are supported" };
    }
    const site = await readPublicWebsite(url);
    const text = JSON.stringify(site).slice(0, 6000);
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "fetch failed" };
  }
}

/**
 * Search the account's own confirmed knowledge: company facts, confirmed
 * paper facts, and remembered decisions. Confirmed rows only — proposed
 * suggestions and raw chats are NOT knowledge.
 */
export async function searchKnowledge(
  sql: any,
  userId: string,
  query: string,
): Promise<Array<{ source: string; label: string; value: string }>> {
  const like = `%${query.trim().slice(0, 80)}%`;
  const companyRows = await sql`
    SELECT label, value FROM buzzy_company_facts
    WHERE user_id = ${userId} AND status = 'confirmed'
      AND (label ILIKE ${like} OR value ILIKE ${like})
    LIMIT 6
  `;
  const paperRows = await sql`
    SELECT label, value FROM buzzy_paper_facts
    WHERE user_id = ${userId} AND status = 'confirmed'
      AND (label ILIKE ${like} OR value ILIKE ${like})
    LIMIT 6
  `;
  const memoryRows = await sql`
    SELECT key AS label, value FROM buzzy_user_memory
    WHERE user_id = ${userId}
      AND (key ILIKE ${like} OR value ILIKE ${like})
    LIMIT 6
  `;
  return [
    ...companyRows.map((r: any) => ({ source: "company facts", label: r.label, value: r.value })),
    ...paperRows.map((r: any) => ({ source: "your documents", label: r.label, value: r.value })),
    ...memoryRows.map((r: any) => ({ source: "remembered decisions", label: r.label, value: r.value })),
  ];
}

/**
 * Planning heuristic: is this job complex enough to ask for a plan first?
 * Deliberately cheap — never always-on (plan doc 23, loop contract).
 */
export function shouldPlanFirst(message: string): boolean {
  const complex =
    message.split(/[.;?!]\s/).filter((s) => s.trim().length > 12).length >= 3 ||
    /\b(and then|after that|also need|plus|step 1|first.*then)\b/i.test(message);
  const short = message.trim().length < 80;
  return complex && !short;
}

/** The plan-first instruction injected into the system prompt for complex jobs. */
export const PLAN_FIRST_INSTRUCTION =
  "\n\nThis is a multi-part job. BEFORE writing anything, reply with a short numbered plan " +
  "(3-6 steps, one line each, plain words) and ask: 'Does this plan look right?' Do not " +
  "produce the deliverable until the owner confirms the plan.";
