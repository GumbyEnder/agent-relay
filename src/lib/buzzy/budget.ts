/**
 * Budget first: how much a project matters, said as money, and what that buys.
 *
 * Owner, 2026-11-23: "we need to restrict how many searches we do based on budget. No
 * bankrupting people for small projects. You need to get an idea of how much this
 * matters to people in the form of budget before you go." Their write-up "The new way
 * forward" adds the two rules this file serves:
 *   - a budget is a guardrail: it limits what is permissible and never dictates how to
 *     solve the problem;
 *   - a guardrail is enforced by the environment, not merely described in a prompt.
 *
 * For work that costs more than an ordinary reply (today: Code Monkey projects):
 *   1. A budget is settled before anything starts: from the person's own words, or from
 *      their answer to ONE question (`BUDGET_QUESTION`). The model can't invent a budget.
 *      The amount has to appear in what the person typed (`settleBudget`).
 *   2. The budget sets the effort (`effortFor`): how many searches, across how many
 *      categorically different areas, and how many versions to try before settling on
 *      one. A $5 bedtime game gets a hundred searches, not ten thousand.
 *   3. The budget is a ceiling: what each delivery cost is counted once
 *      (`countDelivery`), and nothing new starts once the ceiling is reached (money.ts
 *      `budgetVerdict`). Only the person can add more, with one tap.
 *
 * Pure: no I/O. Tested by scripts/test-code-monkey.ts.
 */
import { budgetVerdict, type BudgetVerdict } from "./money";

type Tier = "play" | "product" | "critical";

// ── The one question ─────────────────────────────────────────────────

/** Word for word the same as one mode's (PR #371): one question, one wording. */
export const BUDGET_QUESTION = "How much should I spend on this, at most? I'll keep my work under that amount.";

const CHOICE_DOLLARS: Record<Tier, [number, number, number]> = {
  play: [2, 5, 20],
  product: [20, 50, 200],
  critical: [100, 200, 1000],
};
const CHOICE_WORDS = ["a quick try", "a solid start", "lots of care"] as const;

export interface BudgetChoice {
  dollars: number;
  label: string;
  suggested: boolean;
}

/** Three answers sized to the stakes; the middle one is the suggestion. */
export function budgetChoices(stakes: Tier): BudgetChoice[] {
  return (CHOICE_DOLLARS[stakes] ?? CHOICE_DOLLARS.product).map((d, i) => ({
    dollars: d,
    label: `${money(d * 100)} — ${CHOICE_WORDS[i]}`,
    suggested: i === 1,
  }));
}

/** Did this reply ask the budget question? Then the person's next message is an answer. */
export function askedForBudget(reply: string): boolean {
  return /how much should i spend on this/i.test(String(reply || ""));
}

// ── Reading an amount from the person's own words ────────────────────

export type BudgetSource = "your words" | "your answer";

export interface Amount {
  cents: number;
  /** The sentence it was said in, exactly as typed. */
  sentence: string;
  /** Said next to a word like "budget", "spend", "under", "up to" or "at most". */
  cued: boolean;
}

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?`;
/** Amounts that say they are money: $5, $1,000, $2.50, $2k, 20 dollars, 50 bucks, USD 30. */
const MONEY_PATTERNS: RegExp[] = [
  new RegExp(String.raw`\$\s?${NUM}(\s?k\b)?`, "gi"),
  new RegExp(String.raw`\b${NUM}(\s?k)?\s?(?:dollars?|bucks|usd)\b`, "gi"),
  new RegExp(String.raw`\busd\s?${NUM}(\s?k\b)?`, "gi"),
];
// Only words that clearly say "this is the most to spend on the work". "costs $2.50" or
// "people pay $10 a month" describe the thing being made, not the budget for making it.
const CUE_BEFORE = /\b(budget|spend|spending|up to|at most|max(?:imum)?|no more than|limit|cap|keep (?:it|this|the (?:whole )?(?:thing|project|cost)) (?:under|below|to))\b[^.!?\n]{0,25}$/i;
const CUE_AFTER = /^\s*(max(?:imum)?|tops|budget|or less|limit|at most|cap)\b/i;
/** "budget of 20", "spend 20 at most": a bare number right after a budget word is money too… */
const BARE_AFTER_CUE = /\b(?:budget(?:\s+(?:is|of))?|spend(?:\s+(?:up to|at most))?)\s+(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\b(?!\s*(?:%|percent|minutes?|mins?|hours?|hrs?|days?|weeks?|pages?|words?|people|kids?|years?|mb|gb|levels?|steps?|screens?|items?))/gi;

const UNITS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
/** "five dollars", "twenty-five bucks", "a hundred dollars", "two thousand dollars". */
const WORD_MONEY = /\b((?:a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\s-](?:one|two|three|four|five|six|seven|eight|nine))?(?:\s(?:hundred|thousand))?)\s(?:dollars?|bucks)\b/gi;

function wordsToNumber(phrase: string): number | null {
  const parts = phrase.toLowerCase().split(/[\s-]+/);
  let n = 0;
  for (const p of parts) {
    if (p === "a") n += 1;
    else if (UNITS[p] != null) n += UNITS[p];
    else if (TENS[p] != null) n += TENS[p];
    else if (p === "hundred") n = (n || 1) * 100;
    else if (p === "thousand") n = (n || 1) * 1000;
    else return null;
  }
  return n > 0 ? n : null;
}

function sentenceAround(text: string, start: number, end: number): string {
  const before = text.slice(0, start);
  const from = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("\n")) + 1;
  const rest = text.slice(end);
  const stop = rest.search(/[.!?\n](\s|$)/);
  return text.slice(from, stop < 0 ? text.length : end + stop + 1).trim().slice(0, 240);
}

function toCents(whole: string, frac: string | undefined, k: string | undefined): number {
  const n = Number(whole.replace(/,/g, "")) + (frac ? Number(frac.padEnd(2, "0")) / 100 : 0);
  return Math.round(n * (k && k.trim() ? 1000 : 1) * 100);
}

/**
 * Every amount of money in what someone typed, in order. With `answer`, the text is a
 * reply to the budget question, so a lone number ("20", "let's do 5") or a pick among
 * the offered answers ("the middle one", "the first") counts as dollars too.
 */
export function amountsIn(text: string, opts: { answer?: boolean; stakes?: Tier } = {}): Amount[] {
  const t = String(text || "");
  const spans: Array<{ start: number; end: number; cents: number }> = [];
  for (const re of MONEY_PATTERNS) {
    for (const m of t.matchAll(re)) {
      spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, cents: toCents(m[1]!, m[2], m[3]) });
    }
  }
  for (const m of t.matchAll(WORD_MONEY)) {
    const n = wordsToNumber(m[1]!);
    if (n) spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, cents: n * 100 });
  }
  for (const m of t.matchAll(BARE_AFTER_CUE)) {
    const at = (m.index ?? 0) + m[0].lastIndexOf(m[1]!);
    spans.push({ start: at, end: at + m[1]!.length + (m[2] ? m[2].length + 1 : 0), cents: toCents(m[1]!, m[2], undefined) });
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Amount[] = [];
  let lastEnd = -1;
  for (const s of spans) {
    if (s.start < lastEnd || s.cents <= 0) continue;
    lastEnd = s.end;
    const cued = CUE_BEFORE.test(t.slice(Math.max(0, s.start - 40), s.start)) || CUE_AFTER.test(t.slice(s.end, s.end + 20));
    out.push({ cents: s.cents, sentence: sentenceAround(t, s.start, s.end), cued });
  }
  if (opts.answer && !out.length && t.trim().length <= 80) {
    // A short reply to the budget question: "option 2", "20", "the middle one", "five".
    const sentence = t.trim().slice(0, 240);
    const choices = opts.stakes ? budgetChoices(opts.stakes) : null;
    const option = choices ? /(?:\b(?:option|choice|number)\s*|#\s*)([123])\b/i.exec(t) : null;
    const bare = [...t.matchAll(BARE_NUMBER)];
    const picked = choices ? choiceWordIn(t, choices) : null;
    const words = [...t.matchAll(NUMBER_WORDS)].map((m) => m[1]!).filter((p) => p.toLowerCase() !== "a");
    if (option && choices) out.push({ cents: choices[Number(option[1]) - 1]!.dollars * 100, sentence, cued: true });
    else if (bare.length === 1) out.push({ cents: toCents(bare[0]![1]!, bare[0]![2], undefined), sentence, cued: true });
    else if (!bare.length && picked) out.push({ cents: picked.dollars * 100, sentence, cued: true });
    else if (!bare.length && words.length === 1) {
      const n = wordsToNumber(words[0]!);
      if (n) out.push({ cents: n * 100, sentence, cued: true });
    }
  }
  if (opts.answer) for (const a of out) a.cued = true;
  return out;
}

const BARE_NUMBER = /(?<![\w.$])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?![\w])(?!\s*(?:%|minutes?|hours?|days?|people|kids?|years?))/g;
const NUMBER_WORDS = /\b((?:a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[\s-](?:one|two|three|four|five|six|seven|eight|nine))?(?:\s(?:hundred|thousand))?)\b/gi;

/** "the first one", "the middle", "whatever you suggest", "lots of care": a pick among the offered answers. */
function choiceWordIn(text: string, c: BudgetChoice[]): BudgetChoice | null {
  const t = text.toLowerCase();
  if (/\b(first|1st|cheapest|lowest|smallest|quick try)\b/.test(t)) return c[0]!;
  if (/\b(second|2nd|middle|suggest(ed|ion)?|recommend(ed)?|solid start)\b/.test(t)) return c[1]!;
  if (/\b(third|3rd|last|biggest|highest|largest|lots of care)\b/.test(t)) return c[2]!;
  return null;
}

// ── Settling the budget ──────────────────────────────────────────────

/** Below a dollar no step can run; above this, a typo is likelier than a plan. */
export const BUDGET_LIMITS = { minCents: 100, maxCents: 10_000_000 } as const;

export interface Budget {
  /** The ceiling in cents, top-ups included. */
  cents: number;
  source: BudgetSource;
  /** The person's own sentence that set it. */
  words: string;
  setAt: string;
  /** What they added later, each with one tap of their own. */
  added?: Array<{ cents: number; at: string }>;
}

export interface BudgetInput {
  /** Everything the person typed for this request, oldest first. */
  words: string;
  /** Their reply to the budget question, when this turn is one. */
  answer?: string;
  /** The amount the model read from them, in dollars. It must be one they said. */
  modelDollars?: unknown;
  stakes: Tier;
}

export type BudgetSettled =
  | { ok: true; budget: Budget }
  | { ok: false; reason: "missing" | "not-their-words" | "ambiguous" | "too-small" | "too-large"; choices: BudgetChoice[] };

/**
 * The budget for a new project, or why there isn't one yet. Only the person sets it: the
 * model may say which of their amounts is the budget, but an amount they never typed is
 * refused, and so is a project with no amount at all.
 */
export function settleBudget(input: BudgetInput, now = new Date().toISOString()): BudgetSettled {
  const choices = budgetChoices(input.stakes);
  const fromAnswer = input.answer ? amountsIn(input.answer, { answer: true, stakes: input.stakes }) : [];
  const fromWords = amountsIn(input.words);
  const raw = Number(input.modelDollars);
  const want = input.modelDollars != null && input.modelDollars !== "" && Number.isFinite(raw) && raw > 0 ? Math.round(raw * 100) : null;
  let pick: Amount | undefined;
  if (want !== null) {
    pick = fromAnswer.find((a) => a.cents === want) ?? fromWords.find((a) => a.cents === want);
    if (!pick) return { ok: false, reason: fromAnswer.length || fromWords.length ? "not-their-words" : "missing", choices };
  } else {
    // Without the model's reading, only an unmistakable budget counts: their answer to the
    // question, or one amount said with a budget word ("keep it under $5", "$20 max").
    const cued = fromWords.filter((a) => a.cued);
    pick = fromAnswer[0] ?? (cued.length === 1 ? cued[0] : undefined);
    if (!pick) return { ok: false, reason: fromWords.length > 0 ? "ambiguous" : "missing", choices };
  }
  if (pick.cents < BUDGET_LIMITS.minCents) return { ok: false, reason: "too-small", choices };
  if (pick.cents > BUDGET_LIMITS.maxCents) return { ok: false, reason: "too-large", choices };
  const source: BudgetSource = fromAnswer.includes(pick) ? "your answer" : "your words";
  return { ok: true, budget: { cents: pick.cents, source, words: pick.sentence, setAt: now } };
}

/** The person's own top-up. Returns false (and changes nothing) for an amount out of range. */
export function addToBudget(budget: Budget, cents: number, now = new Date().toISOString()): boolean {
  if (!Number.isFinite(cents) || cents < BUDGET_LIMITS.minCents || cents > BUDGET_LIMITS.maxCents) return false;
  budget.cents += Math.round(cents);
  budget.added = [...(budget.added ?? []), { cents: Math.round(cents), at: now }];
  return true;
}

// ── What the budget buys ─────────────────────────────────────────────

/** Unit costs. Defaults are deliberately generous estimates; set the env vars when prices move. */
export function unitCents() {
  const n = (key: string, dflt: number) => {
    const v = Number(process.env[key]);
    return Number.isFinite(v) && v > 0 ? v : dflt;
  };
  return {
    /** One web search, including reading what it finds. */
    search: n("BZ_SEARCH_CENTS", 1),
    /** One quick version of a first step, to compare before settling on one. */
    version: n("BZ_VERSION_CENTS", 300),
    /** A delivery that reports no cost still counts this much: effort is never free, and
     *  an agent that reports nothing can't run past the ceiling. */
    floor: n("BZ_CODE_STEP_FLOOR_CENTS", 50),
    /** Used when a delivery reports tokens but no price: cents per million tokens. */
    inPerMTok: n("BZ_CODE_IN_CENTS_PER_MTOK", 300),
    outPerMTok: n("BZ_CODE_OUT_CENTS_PER_MTOK", 1500),
  };
}

/**
 * How the budget is spent, as an equation:
 *
 *   searches = ⌊ budget × 20% ÷ cost of one search ⌋, at most 1,000 per area × 10 areas
 *   areas    = ⌈ searches ÷ 50 ⌉, from 1 to 10 (categorically different subjects)
 *   versions = ⌊ budget × 20% ÷ cost of one quick version ⌋, from 1 to 50
 *
 * The rest (60% or more) builds and checks. With the default unit costs: $2 buys 40
 * searches in one area and one version; $5 buys 100 searches in 2 areas; $50 buys 1,000
 * searches in 10 areas and 3 versions; $500 reaches the write-up's full 1,000 searches
 * in each of 10 areas.
 */
export const EFFORT = {
  RESEARCH_SHARE: 0.2,
  VERSIONS_SHARE: 0.2,
  SEARCHES_PER_AREA_MAX: 1000,
  SEARCHES_PER_AREA_STEP: 50,
  AREAS_MAX: 10,
  VERSIONS_MAX: 50,
} as const;

export interface Effort {
  searches: number;
  areas: number;
  versions: number;
}

export function effortFor(cents: number): Effort {
  const u = unitCents();
  const c = Number.isFinite(cents) && cents > 0 ? cents : 0;
  const searches = Math.min(EFFORT.SEARCHES_PER_AREA_MAX * EFFORT.AREAS_MAX, Math.floor((c * EFFORT.RESEARCH_SHARE) / u.search));
  const areas = searches > 0 ? Math.min(EFFORT.AREAS_MAX, Math.max(1, Math.ceil(searches / EFFORT.SEARCHES_PER_AREA_STEP))) : 0;
  const versions = Math.min(EFFORT.VERSIONS_MAX, Math.max(1, Math.floor((c * EFFORT.VERSIONS_SHARE) / u.version)));
  return { searches, areas, versions };
}

// ── Counting what was spent ──────────────────────────────────────────

export interface UsageLike {
  tokensIn?: number;
  tokensOut?: number;
  estimatedUsd?: number;
}

export interface Spend {
  usedCents: number;
  /** Mission id → fingerprint of the delivery already counted, so nothing counts twice. */
  counted: Record<string, string>;
  /** Deliveries that reported no cost and were counted at the floor. */
  unreported: number;
}

export function emptySpend(): Spend {
  return { usedCents: 0, counted: {}, unreported: 0 };
}

/** What one delivery cost: its own estimate, else its tokens at the default price, else the floor. */
export function deliveryCents(usage: UsageLike | null | undefined): { cents: number; reported: boolean } {
  const u = unitCents();
  const usd = Number(usage?.estimatedUsd);
  if (Number.isFinite(usd) && usd > 0) return { cents: Math.max(1, Math.round(usd * 100)), reported: true };
  const tin = Number(usage?.tokensIn) || 0;
  const tout = Number(usage?.tokensOut) || 0;
  if (tin > 0 || tout > 0) return { cents: Math.max(1, Math.round((tin * u.inPerMTok + tout * u.outPerMTok) / 1e6)), reported: true };
  return { cents: u.floor, reported: false };
}

/** Same delivery, same fingerprint — however the board happens to shape the usage object when it reads it back. */
function fingerprint(delivery: string, usage: UsageLike | null | undefined): string {
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const s = `${delivery}\u0000${n(usage?.tokensIn)}|${n(usage?.tokensOut)}|${n(usage?.estimatedUsd)}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ":" + s.length.toString(36);
}

/** Count a delivery once. Returns true when it was new (so the caller saves). */
export function countDelivery(spend: Spend, missionId: string, delivery: string | undefined, usage: UsageLike | null | undefined): boolean {
  if (!missionId || !delivery) return false;
  const key = fingerprint(delivery, usage);
  if (spend.counted[missionId] === key) return false;
  const c = deliveryCents(usage);
  spend.usedCents += c.cents;
  if (!c.reported) spend.unreported += 1;
  spend.counted[missionId] = key;
  return true;
}

// ── What the person sees ─────────────────────────────────────────────

export interface BudgetView {
  capCents: number;
  usedCents: number;
  /** allow: work starts as usual. ask: close to the limit, new work waits for a tap. refuse: at the limit. */
  verdict: BudgetVerdict;
  source: BudgetSource;
  words: string;
  addedCents: number;
  /** Deliveries that didn't say what they cost (counted at the floor). */
  unreported: number;
  /** "$1.20 of $5 used". */
  line: string;
}

export function budgetView(budget: Budget | undefined, spend: Spend | undefined): BudgetView | null {
  if (!budget) return null;
  const used = spend?.usedCents ?? 0;
  return {
    capCents: budget.cents,
    usedCents: used,
    verdict: budgetVerdict(used, budget.cents).verdict,
    source: budget.source,
    words: budget.words,
    addedCents: (budget.added ?? []).reduce((n, a) => n + a.cents, 0),
    unreported: spend?.unreported ?? 0,
    line: `${money(used)} of ${money(budget.cents)} used`,
  };
}

/** $5, $1.20, $1,000. */
export function money(cents: number): string {
  const c = Math.max(0, Math.round(Number(cents) || 0));
  return c % 100 === 0
    ? "$" + (c / 100).toLocaleString("en-US")
    : "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
