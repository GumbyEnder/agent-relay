/**
 * Ask first, or just go: BeeZilla's rule for when a request is worth stopping for.
 *
 * Owner, 2026-11-23: optimise for people's satisfaction over the long haul. Any
 * friction (a question, an approval, a plan to read) has to be justified, because
 * over-cautious tools waste people's time, which is why most people end up switching
 * their safeguards off. So the decision is an equation, not a habit:
 *
 *   ask  ⟺  P(misreading the intent) × the cost of getting it wrong
 *                × can't-undo (1, or 10 for a one-way door) × stakes (play 1, product 3, critical 10)
 *            >  the person's time to answer × hurry (1, or 4 when they are rushed)
 *
 * These are the numbers on the owner-facing conclusions page (the research session,
 * 2026-11-23), so BeeZilla and what the owner reads agree.
 * and the answer a person gives to "questions first, or just go?" is remembered per
 * stakes tier, so they are asked once and then not again.
 *
 * Pure and BeeZilla-wide: Talk uses it through oneMode.ts (the quick choice, the
 * questions, the ticket), and any other surface (Code Monkey's coding workspace)
 * can take the same tier and the same rule. Tested by scripts/test-one-mode.ts.
 * Research the owner's sessions gathered points the same way: for work that can be
 * undone, doing it and showing the evidence beats planning it first; keep stopping
 * for the one-way doors (sending, paying, publishing, deleting).
 */

// ── The assessment: the equation's inputs ────────────────────────────

export type Size = "small" | "medium" | "large";
export type Stakes = "play" | "product" | "critical";

export interface Assessment {
  size: Size;
  /** play: personal or for fun. product: for other people, a business, the public.
   *  critical: a mistake would be devastating (money, health, legal, security, real
   *  people's data, production systems). */
  stakes: Stakes;
  /** Feeds a step that cannot be taken back: sending, publishing, paying, deleting,
   *  deploying, signing. (Those steps still wait for the person's OK elsewhere; this
   *  only says a misreading would be expensive.) */
  irreversible: boolean;
  /**
   * The request performs the door itself ("send it to all our customers"), rather
   * than mentioning it inside work that makes something ("write a tweet announcing
   * our sale") or asking about it ("how do I publish this?" — already not
   * irreversible). The equation can price a mention as a small readable mistake, but
   * a performed door leaves the account, so `askFirst` never lets it go silently.
   */
  performsDoor?: boolean;
  /** They seem to be in a hurry ("quick", "asap", "right now"). */
  hurried: boolean;
  /** P(BeeZilla misreads what they want), 0..1. */
  pMisread: number;
  /** The words that moved each input, for the log line and the tests. */
  why: string[];
}

export interface AssessContext {
  /** Earlier messages from the person in this conversation. */
  priorTurns?: number;
  /** Facts already captured for this conversation (decisions, ticket lines). */
  knownFacts?: number;
  /** A draft exists and this turn is about it. */
  hasDraft?: boolean;
  /** The Idea Board says who it serves or what the end result is. */
  hasBoardBrief?: boolean;
  /** A maker lane (picture, track, 3D model, video, recipe) handles this request
   *  with sensible defaults and its own intake: cheap to redo, never interviewed. */
  makerLane?: boolean;
  /** The caller's own reading of the stakes (a workspace on a live repository, a
   *  company account). The words can raise the tier from here, never lower it. */
  minStakes?: Stakes;
}

/** A sentence that asks for information rather than for something to be made. */
export const QUESTION = /^\s*(how|what|what's|whats|why|where|when|which|who|whose|is|are|was|were|does|do|did|should|could you explain|can you explain|tell me (about|how|what|why))\b/i;

/** Verbs that start something bigger than an answer. */
const BUILD_VERB = "(make|making|build|building|create|creating|develop|design|code|program|launch|start|set ?up|run|plan|planning|organi[sz]e|publish|produce|put together|come up with|grow|scale|migrate|redesign|overhaul|rewrite|write|draft|prepare|compose|fix|debug|refactor|implement|integrate|automate|update)";

/** Projects: work that takes hours or days and has many parts. */
const LARGE_NOUN =
  "(apps?|applications?|games?|video ?games?|web ?sites?|sites|platforms?|business(es)?|start-?ups?|companies|company|stores?|shops?|marketplaces?|campaigns?|courses?|curriculum|books?|novels?|series|products?|systems?|software|tools?|bots?|chatbots?|dashboards?|brands?|brand identity|strateg(y|ies)|events?|part(y|ies)|weddings?|conferences?|festivals?|trips?|vacations?|renovations?|portals?|apis?|databases?|pipelines?|automations?|integrations?|extensions?|plugins?|podcasts?|channels?|communit(y|ies))";

/** Documents: a page or several of real work. */
const MEDIUM_NOUN =
  "(business plans?|marketing plans?|bugs?|letters?|proposals?|reports?|essays?|articles?|blog posts?|posts|polic(y|ies)|contracts?|agreements?|quotes?|estimates?|invoices?|resumes?|cvs?|cover letters?|presentations?|decks?|slides|spreadsheets?|budgets?|schedules?|itinerar(y|ies)|menus?|lesson plans?|lessons?|stor(y|ies)|scripts?|speech(es)?|guides?|checklists?|manuals?|handbooks?|press releases?|descriptions?|brochures?|flyers?|ads?|adverts?|plans?|outlines?|summar(y|ies)|reviews?|analys[ie]s|research|comparisons?|templates?|forms?|surveys?|questionnaires?|landing pages?|web ?pages?|lyrics|newsletters?|songs?)";

/** Short pieces: a minute to read, seconds to redo. */
const SMALL_NOUN =
  "(e-?mails?|messages?|texts?|repl(y|ies)|tweets?|captions?|titles?|headlines?|slogans?|taglines?|names?|bios?|sentences?|paragraphs?|notes?|comments?|jokes?|poems?|haikus?|limericks?|subject lines?|toasts?|greetings?|cards?|definitions?|translations?)";

const VERB = new RegExp(`\\b${BUILD_VERB}\\b`, "gi");
const NOUNS: Array<[Size, RegExp]> = [
  ["large", new RegExp(`\\b${LARGE_NOUN}\\b`, "gi")],
  ["medium", new RegExp(`\\b${MEDIUM_NOUN}\\b`, "gi")],
  ["small", new RegExp(`\\b${SMALL_NOUN}\\b`, "gi")],
];
/** "I want my own app", "we need a new website". */
const WANT_LARGE = new RegExp(`\\b(i|we)\\s+(want|need|would like|'d like)\\s+(to\\s+(make|build|start|launch|create)\\s+)?(an?|my|our|the)?\\s*(own\\s+|new\\s+)?${LARGE_NOUN}\\b`, "i");

/**
 * The size of what they want made: the first thing named after a verb of making.
 * "Write a launch tweet for our new app" is a tweet, not an app: the app is who it
 * is for. On a tie the longer name wins ("a business plan" is a document, not a
 * business).
 */
function objectSize(m: string): { size: Size; noun: string } | null {
  for (const v of m.matchAll(VERB)) {
    const after = m.slice((v.index ?? 0) + v[0].length).split(/[.!?\n]/)[0]!.slice(0, 90);
    let best: { idx: number; len: number; size: Size; noun: string } | null = null;
    for (const [size, re] of NOUNS) {
      for (const n of after.matchAll(re)) {
        const idx = n.index ?? 0;
        if (!best || idx < best.idx || (idx === best.idx && n[0].length > best.len)) {
          best = { idx, len: n[0].length, size, noun: n[0] };
        }
      }
    }
    if (best) return { size: best.size, noun: `${v[0]} … ${best.noun}` };
  }
  const want = WANT_LARGE.exec(m);
  if (want) return { size: "large", noun: want[0] };
  // No verb of making: the first thing named ("Email all our customers…").
  let first: { idx: number; len: number; size: Size; noun: string } | null = null;
  for (const [size, re] of NOUNS) {
    for (const n of m.matchAll(re)) {
      const idx = n.index ?? 0;
      if (!first || idx < first.idx || (idx === first.idx && n[0].length > first.len)) first = { idx, len: n[0].length, size, noun: n[0] };
    }
  }
  return first ? { size: first.size, noun: first.noun } : null;
}

const MULTI_PART = /\b(and then|after that|as well as|on top of that|step \d)\b|;\s|\balso\b[^.!?\n]{0,40}\b(need|want|make|add)\b/i;

/** A mistake would be devastating: money, health, legal, security, people's data, production. */
const CRITICAL: Array<[string, RegExp]> = [
  ["money", /\b(checkout|payments?|billing|charg(e|es|ed|ing) (customers?|cards?|users?|people)|refunds?|payroll|tax(es)?|tax return|irs|hmrc|loans?|mortgages?|invest(ing|ment|ments)?|portfolio|stocks?|crypto|bitcoin|wire (transfer|money)|bank accounts?|routing number|credit cards?|chargebacks?|pay (my|our|the) (staff|employees|team|vendors?|contractors?|suppliers?|bills?|invoices?)|financial (statements?|reports?)|move (the )?money|(pay|paid|wire|transfer|send)\b[^.!?\n]{0,40}(\$\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:dollars?|usd|eur|gbp)\b))\b/i],
  ["health", /\b(medical|medicine|medications?|meds|doses?|dosage|prescriptions?|diagnos(is|e|ed)|symptoms?|allerg(y|ies|ic)|pregnan(t|cy)|surgery|treatment plan|mental health|suicid\w*|overdose|vaccines?|insulin|blood pressure|chemo\w*|patients?|clinical|hospital)\b/i],
  ["legal", /\b(legal|lawyers?|attorneys?|lawsuits?|sue|suing|court|judge|contracts?|terms of (service|use)|privacy policy|compliance|gdpr|hipaa|liabilit(y|ies)|tos|t&c'?s?|(write|draft|update|make) (a|my|our) will|will and testament|living will|estate plan|custody|divorce|immigration|visas?|evict(ion)?|cease and desist|demand letter|settlement|nda|non-disclosure|trademark|patent)\b/i],
  ["security", /\b(passwords?|credentials|api keys?|secret keys?|private keys?|encrypt(ion)?|security|vulnerabilit(y|ies)|exploits?|breach(es)?|hack(ed|ing)?|two-factor|2fa|permissions|access control|firewall)\b/i],
  ["people's data", /\b(customer (data|records|database|list|details|info)|user (data|records|accounts|database)|personal data|pii|patient records|(our|the|my) database|mailing list|everyone'?s (data|emails?|details))\b/i],
  ["production", /\b(production|prod|live (site|server|app|system)|deploy(ing|ment)?|outages?|downtime|migrat(e|ion|ing)|rollback|restore (the|our|a) (backup|database)|dns)\b/i],
];

/** For other people: a business, customers, the public. */
const PRODUCT = /\b(customers?|clients?|users|audience|public(ly)?|publish(ing|ed)?|launch(ing|ed)?|sell(ing)?|sales|marketing|brand(ing)?|business(es)?|company|startup|store|shop|bakery|restaurant|caf[eé]|salon|studio|gym|agency|firm|nonprofit|charity|organi[sz]ation|club|our school|my school|investors?|pitch|my team|our team|employees|staff|students|my class|everyone|everywhere|the world|thousands|millions|subscribers|followers|invoices?|quotes?|estimates?|proposals?|resumes?|cvs?|cover letters?|job applications?|app store|play store)\b/i;

/** Personal, for fun. Only explains a call: "play" is also the default. */
const PLAY = /\b(for fun|just for fun|my kids?|my children|my son|my daughter|my family|bedtime|birthday|hobby|for myself|game night|my friends|weekend|date night|practice|homework|my pet)\b/i;

/** Feeds a step that cannot be taken back. */
const IRREVERSIBLE = /\b(send(ing)? (it|this|that|them|out|to|the|a|an|our|my|these|those|everyone|all)|email (it|this|them|everyone|all)|post (it|this|that)|publish|tweet (it|this)|pay|transfer|wire|delete|remove all|wipe|drop (the|our|my)|deploy|launch|go live|submit|file (the|a|my|our)\s*(claim|lawsuit|taxes|return|report)|sign (the|it|this)|order|buy|purchase|cancel (my|our|the)|terminate|fire (him|her|them)|evict|announce|migrate|overwrite|mass e-?mail|email blast)\b/i;

/** They seem to be in a hurry. "Just do it" is stronger than this: see isGoReply. */
const HURRIED = /\b(quick(ly)?|asap|a\.s\.a\.p|urgent(ly)?|right now|right away|immediately|hurry|in a rush|rushed|no time|real quick|need (it|this) (now|today|tonight)|by tonight|by end of (the )?day|eod|in \d+ ?(min|mins|minutes))\b|!!/i;

/**
 * The leading verb of a request that *performs* a one-way door: the act itself
 * leaves the account, so a misreading cannot be read and corrected afterwards.
 *
 * Only the first verb counts, after the usual politeness and auxiliary words.
 * "Send it to all our customers" performs a send; "write a tweet announcing our
 * sale" mentions one inside a maker lane (nothing leaves, so it must stay a go);
 * "how do I publish this?" is a question, and `irreversible` is already false
 * there. Buying and ordering are deliberately absent: they cost money but nothing
 * leaves the account, and pulling them in would add a tap to ordinary requests.
 */
const DOOR_VERB =
  /^(?:(?:please|now|just|ok(?:ay)?|and|also|then|so|go ahead and|i (?:want|need|'d like) you to|can you|could you|would you|will you)[,\s]+)*(send|email|e-?mail|mail|announce|publish|post|tweet|mass e-?mail|email blast|pay|wire|transfer|delete|remove|wipe|drop|deploy|launch|cancel|refund|terminate|fire|evict|submit|migrate|overwrite)\b/i;

/** Words that leave the result open. */
const VAGUE = /\b(something|anything|some kind of|some sort of|stuff|whatever|ideas?|not sure|maybe|i don'?t know|dunno|cool|nice|fun|better|awesome|amazing|help me( with)?|figure out|kind of|sort of)\b/gi;

/** Concrete details that pin the result down. */
const DETAIL_PATTERNS: RegExp[] = [
  /\d+/g, // numbers: ages, sizes, dates, prices
  /["“][^"”]{2,80}["”]/g, // their exact words
  /\bfor (my|our|his|her|their|the) [a-z][\w'-]+/gi, // who it is for
  /\b(about|on the topic of|set in|based on) [a-z][\w'-]+/gi, // its subject
  /\b(colou?rs?|style|tone|font|deadline|budget|pages?|words?|minutes?|slides?|ios|android|iphone|mac|windows|shopify|wordpress|square|stripe|instagram|tiktok|youtube|linkedin|facebook|pdf|excel|python|javascript|react|in (english|spanish|french|german|portuguese|chinese|japanese))\b/gi,
];

const BASE_P: Record<Size, number> = { small: 0.1, medium: 0.25, large: 0.45 };

/** Capitalised words that are not the first of a sentence: names of places, brands, people. */
function properNouns(message: string): number {
  let n = 0;
  for (const sentence of message.split(/(?<=[.!?])\s+|\n+/)) {
    const words = sentence.trim().split(/\s+/).slice(1);
    for (const w of words) if (/^[A-Z][a-z]+/.test(w) && w !== "I" && !/^I'/.test(w)) n++;
  }
  return n;
}

function bump(size: Size): Size {
  return size === "small" ? "medium" : "large";
}

/**
 * Size, stakes, irreversibility, hurry and P(misreading), from the words alone.
 *
 * Deliberately cheap and deterministic: it runs on every turn before anything else,
 * adds no latency, and every call can be explained from the `why` list. A model-based
 * assessor can replace this later without touching `askOrGo`: the equation only needs
 * these five numbers.
 */
/** An order at the start of a message: "write…", "also make…", "could you draft…". */
const IMPERATIVE = new RegExp(
  `^\\s*(?:(?:please|also|and|now|ok(?:ay)?|oh|actually|then|separately|btw|by the way|meanwhile|in the meantime)[,:\\s]+)*(?:(?:can|could|would|will) you\\s+)?(?:please\\s+)?${BUILD_VERB}\\b`,
  "i",
);
/** "Also…", "by the way…", "separately…": they are starting something else. */
const SEPARATE = /^\s*(also|separately|unrelated|by the way|btw|meanwhile|in the meantime|while (you|we) wait|different (question|thing)|another thing|new (request|task))\b/i;

/**
 * Does this message start a new piece of work, rather than answer a pending
 * question about `pending`? An order that names something to make ("write a tweet
 * announcing it") is new; one about the thing being asked about ("make the website
 * pink") or a requirement ("make sure the menu is on every page") is an answer.
 * Conservative on purpose: when unsure, it is an answer.
 */
export function startsNewRequest(message: string, pending = ""): boolean {
  const m = String(message || "").trim();
  if (SEPARATE.test(m)) return true;
  if (!IMPERATIVE.test(m) || /^\s*(?:\w+[,\s]+)?make sure\b/i.test(m)) return false;
  const object = objectSize(m);
  if (!object) return false;
  const noun = object.noun.split(" … ").pop()!.toLowerCase().replace(/s$/, "");
  return !String(pending).toLowerCase().includes(noun);
}

export function assessRequest(message: string, ctx: AssessContext = {}): Assessment {
  const m = String(message || "").trim();
  const why: string[] = [];

  // ── Size ──
  let size: Size;
  if (ctx.makerLane) {
    size = "small";
    why.push("a maker lane makes it with defaults");
  } else if (ctx.hasDraft) {
    size = "small";
    why.push("a change to the draft on file");
  } else if (QUESTION.test(m)) {
    size = "small";
    why.push("a question to answer");
  } else {
    const object = objectSize(m);
    if (object) {
      size = object.size;
      why.push(`${size === "large" ? "a project" : size === "medium" ? "real work" : "a short piece"}: ${object.noun.slice(0, 60)}`);
    } else {
      size = m.split(/\s+/).length > 60 ? "medium" : "small";
      why.push(size === "medium" ? "a long request" : "a short request");
    }
  }
  if (size !== "large" && !ctx.makerLane && !ctx.hasDraft && !QUESTION.test(m) && MULTI_PART.test(m)) {
    size = bump(size);
    why.push("several parts");
  }

  // ── Stakes ── (the highest tier any signal reaches; code only ever raises it)
  let stakes: Stakes = "play";
  const critical = CRITICAL.find(([, re]) => re.test(m));
  if (critical) {
    stakes = "critical";
    why.push(`critical (${critical[0]}): ${m.match(critical[1])?.[0]}`);
  } else if (PRODUCT.test(m)) {
    stakes = "product";
    why.push("for other people: " + m.match(PRODUCT)?.[0]);
  } else {
    why.push(PLAY.test(m) ? "personal: " + m.match(PLAY)?.[0] : "personal (no sign it is for others)");
  }
  const TIER_ORDER: Stakes[] = ["play", "product", "critical"];
  if (ctx.minStakes && TIER_ORDER.indexOf(ctx.minStakes) > TIER_ORDER.indexOf(stakes)) {
    stakes = ctx.minStakes;
    why.push(`at least ${ctx.minStakes} (the caller's reading)`);
  }

  const irreversible = IRREVERSIBLE.test(m) && !QUESTION.test(m);
  if (irreversible) why.push("cannot be taken back: " + m.match(IRREVERSIBLE)?.[0]);
  // A door described inside work that makes something ("write a tweet announcing
  // our sale", "draft the email") is not performed here: the deliverable is a draft
  // the person reads, and the maker lanes already stop short of sending. Likewise a
  // change to a draft on file.
  const performsDoor =
    irreversible && !ctx.makerLane && !ctx.hasDraft && !QUESTION.test(m) && DOOR_VERB.test(m);
  if (performsDoor) why.push("the door itself: " + m.match(DOOR_VERB)?.[1]);
  const hurried = HURRIED.test(m);
  if (hurried) why.push("in a hurry: " + m.match(HURRIED)?.[0]);

  // ── P(misreading) ──
  let p = BASE_P[size];
  const vague = (m.match(VAGUE) ?? []).length;
  if (vague) {
    p += Math.min(0.3, 0.12 * vague);
    why.push(`${vague} open word${vague === 1 ? "" : "s"}`);
  }
  let details = Math.min(3, properNouns(m));
  for (const re of DETAIL_PATTERNS) details += Math.min(3, (m.match(re) ?? []).length);
  details = Math.min(6, details);
  if (details) {
    p *= Math.pow(0.8, details);
    why.push(`${details} concrete detail${details === 1 ? "" : "s"}`);
  }
  const words = m.split(/\s+/).filter(Boolean).length;
  if (words > 40) p *= 0.8;
  if (words > 80) p *= 0.85;
  if ((ctx.priorTurns ?? 0) >= 2) p *= 0.8;
  if ((ctx.knownFacts ?? 0) >= 2) p *= 0.7;
  if (ctx.hasBoardBrief) p *= 0.6;
  if (ctx.hasDraft) p *= 0.5;
  const pMisread = Math.round(Math.min(0.9, Math.max(0.03, p)) * 1000) / 1000;

  return { size, stakes, irreversible, performsDoor, hurried, pMisread, why };
}

// ── The rule ─────────────────────────────────────────────────────────

/**
 * The constants of the equation, in minutes of the person's time.
 *
 *   ask  ⟺  P(misread) × REDO[size] × STAKES[stakes] × (irreversible ? CANT_UNDO : 1)
 *            >  ANSWER × (hurried ? HURRY : 1)
 *
 * Left: the expected cost of going ahead and getting it wrong. Right: the cost of
 * stopping to ask. With these numbers the threshold is 3 minutes normally and 12
 * when they are in a hurry, so:
 *   - small things almost never ask (the left side tops out at 0.45 × 0.5 × 10 × 10 =
 *     22.5 only for a critical, irreversible, very vague one; most stay under 1);
 *   - personal projects ask only when they are big AND open ("make me a game");
 *   - work for other people asks when it is big and still open ("build a website for
 *     my bakery");
 *   - critical work asks even when it is fairly clear, and even in a hurry;
 *   - whatever the equation says, a request that *performs* a one-way door (send,
 *     publish, announce, pay, delete, deploy) is never silent: `askFirst` offers the
 *     one choice whatever its size, and only a remembered "just go" for play skips it.
 */
export const ASK_OR_GO = {
  /** What a wrong guess costs the person: reading it, saying what is wrong, waiting
   *  for the redo. A short piece is glanced at; a project is lived with. */
  REDO_MINUTES: { small: 0.5, medium: 4, large: 8 } as Record<Size, number>,
  /** How much worse a mistake is when other people, or real harm, are involved. */
  STAKES_WEIGHT: { play: 1, product: 3, critical: 10 } as Record<Stakes, number>,
  /** A mistake that feeds a step that cannot be taken back (sending, paying,
   *  publishing, deleting): ten times worse than one that can be undone. */
  CANT_UNDO_WEIGHT: 10,
  /** The person's time to answer: a real question costs 1–2 minutes, a tap on a
   *  suggested answer about 10 seconds, and every question is a round trip of waiting.
   *  The quick choice plus a few suggested answers comes to about three minutes. */
  ANSWER_MINUTES: 3,
  /** Interrupting someone who is clearly rushed costs four times as much. */
  HURRY_WEIGHT: 4,
} as const;

export interface AskOrGo {
  ask: boolean;
  /** Expected minutes lost by going ahead and misreading it. */
  costOfMisreading: number;
  /** Minutes the person spends being asked. */
  costOfAsking: number;
  /** One line with the numbers, for logs. */
  why: string;
}

export function askOrGo(a: Assessment): AskOrGo {
  const k = ASK_OR_GO;
  const costOfMisreading =
    a.pMisread * k.REDO_MINUTES[a.size] * k.STAKES_WEIGHT[a.stakes] * (a.irreversible ? k.CANT_UNDO_WEIGHT : 1);
  const costOfAsking = k.ANSWER_MINUTES * (a.hurried ? k.HURRY_WEIGHT : 1);
  const ask = costOfMisreading > costOfAsking;
  const r = (n: number) => Math.round(n * 100) / 100;
  const why =
    `${ask ? "ask" : "go"}: ${a.pMisread} × ${k.REDO_MINUTES[a.size]} (${a.size}) × ${k.STAKES_WEIGHT[a.stakes]} (${a.stakes})` +
    `${a.irreversible ? ` × ${k.CANT_UNDO_WEIGHT} (can't undo)` : ""} = ${r(costOfMisreading)} ` +
    `${ask ? ">" : "≤"} ${r(costOfAsking)}${a.hurried ? " (hurried)" : ""}`;
  return { ask, costOfMisreading: r(costOfMisreading), costOfAsking: r(costOfAsking), why };
}

// ── Asked once, then not again ──────────────────────────────────────────

/** What the person answered to "questions first, or just go?" for a kind of work. */
export type AskPreference = "ask" | "go";

/** What to do with a request: just go, offer the one quick choice, or start the
 *  questions straight away (they chose questions for this kind of work before). */
export type AskFirst = "go" | "offer" | "questions";

/**
 * The rule, then their remembered answer for this stakes tier. A request the rule
 * would stop for is offered the choice only the first time: after that, their own
 * answer decides, so the long-run effect is fewer questions, not more.
 *
 * One thing the equation must not be allowed to swallow: a request that *performs*
 * a one-way door. `CANT_UNDO_WEIGHT` alone cannot lift a small, clear, product-stakes
 * send over the 3-minute threshold (0.1 × 0.5 × 3 × 10 = 1.5), so "send it to all our
 * customers" used to go ahead unannounced. A performed door is never silent: it is at
 * least offered, whatever the size, at every tier but play, where their remembered
 * "just go" still stands (it is their own data and their own call).
 */
export function askFirst(
  verdict: AskOrGo,
  remembered: AskPreference | null | undefined,
  a?: Pick<Assessment, "stakes" | "irreversible" | "performsDoor">,
): AskFirst {
  if (!verdict.ask) {
    if (!(a?.irreversible && a.performsDoor)) return "go";
    if (remembered === "ask") return "questions";
    if (remembered === "go" && a.stakes === "play") return "go";
    return "offer";
  }
  if (remembered === "ask") return "questions";
  // The one exception to "asked once": a one-way door with critical stakes (paying,
  // deleting real data, publishing a legal text) is offered the choice every time.
  if (remembered === "go" && !(a?.stakes === "critical" && a.irreversible)) return "go";
  return "offer";
}

/** Where a person's answer is kept: account-wide, one row per tier. */
export function askPreferenceKey(stakes: Stakes): string {
  return `ask_first:${stakes}`;
}

const TIER_WORDS: Record<Stakes, string> = {
  play: "Personal projects",
  product: "Work for other people",
  critical: "Critical work (money, health, legal, security, people's data, live systems)",
};

/** The remembered answer in words, as the Memory page shows it. */
export function askPreferenceText(stakes: Stakes, pref: AskPreference): string {
  return `${TIER_WORDS[stakes]}: ${pref === "go" ? "just go, no questions first" : "a few questions first"}`;
}

/** Read a stored answer back (the words above, or a bare "ask"/"go"). */
export function readAskPreference(value: string | null | undefined): AskPreference | null {
  const v = String(value ?? "").toLowerCase();
  if (/just go|^go$/.test(v)) return "go";
  if (/questions first|^ask$/.test(v)) return "ask";
  return null;
}

// ── The budget: money spent can't be taken back ─────────────────────────
//
// Owner, 2026-11-23: "No bankrupting people for small projects. You need to get an
// idea of how much this matters to people in the form of budget before you go."
// Work handed to agents (a coding project, research at scale) costs more than an
// ordinary reply, so before it starts the person says how much to spend, once. In the
// equation that is a can't-undo cost: a wrong guess is money already gone, and the
// question is one tap. Nothing done inside a reply (an answer, a tweet, a picture, a
// plan written in the turn) ever asks it.

/** Verbs of making software: the same ones Code Monkey's isCodeRequest uses. */
const CODE_VERB = /\b(build|make|create|code|program|develop|write|design|set ?up|put together|spin up)\b/gi;

/**
 * Software, when it is the thing being made. A subset of the nouns Code Monkey's
 * isCodeRequest (codeMonkey.ts) offers its tool for, kept narrower on purpose: this
 * test stops to ask, so a word that is often not software ("a workout program", "a
 * script for my video", "a one-page summary", "a board game") does not count.
 */
const SOFTWARE = new RegExp(
  "\\b(" +
    [
      "apps?",
      "(?<!\\b(?:board|card|party|drinking|dice|word|guessing|lawn|outdoor|ball|team|trivia) )(?:video ?)?games?(?! ?(?:nights?|days?|plans?|shows?|rooms?))",
      "web ?sites?",
      "sites?(?! (?:visits?|plans?|surveys?|inspections?|maps?))",
      "webpages?",
      "(?:web|landing|booking|sign-?up|order(?:ing)?|home|contact|product|sales|event|donation|checkout) pages?",
      "tools?",
      "bots?",
      "chatbots?",
      "(?:browser|chrome|firefox|safari|edge|vs ?code) extensions?",
      "plug-?ins?",
      "(?:computer|software) programs?",
      "dashboards?",
      "apis?",
      "back-?ends?",
      "databases?",
      "features?(?! (?:articles?|stor(?:y|ies)|pieces?|films?|writing))",
      "prototypes?",
      "widgets?",
      "calculators?",
      "trackers?",
      "(?:online|web) ?shops?",
      "store ?fronts?",
    ].join("|") +
    ")\\b",
  "i",
);

/** Changing software that exists: "fix the typo on my website", "add a blog to our site". */
const CHANGE_SOFTWARE =
  /\b(add|change|fix|update|improve|edit|tweak|redesign|rebuild|speed up)\b[^.?!\n]{0,40}\b(my|the|our|this)\s+(apps?|games?|web ?sites?|site|web ?pages?|landing page|code|codebase|repo|repository|dashboard|bot|chatbot|database|api|back-?end|online shop|plug-?in|extension)\b/i;
const CODE_WORDS = /\b(fix (the|a|this) bug|debug (my|the|this)|refactor|deploy (my|the|this)|code monkey)\b/i;

/** The words right after a verb of making, up to "for", "about", a comma…: the thing made. */
function madeThing(after: string): string {
  return after
    .split(/[.,;:!?\n]|\b(?:for|about|on|to|with|that|which|where|who|so|in|of|from|by|at|using|like|than|and|but)\b/i)[0]!
    .split(/\s+/)
    .slice(0, 9)
    .join(" ");
}

/** A question about the work rather than an order for it: "How do I build a website?",
 *  "Do you make apps?". "Do deep research on…" is an order. */
function asksAbout(m: string): boolean {
  return QUESTION.test(m) && (/\?\s*$/.test(m) || /^\s*(how|what|what's|whats|why|where|when|which|who|whose)\b/i.test(m));
}

/** Software to be made or changed: Code Monkey's coding projects. */
export function isCodeWork(message: string): boolean {
  const m = String(message || "").trim();
  if (!m || asksAbout(m)) return false;
  if (CHANGE_SOFTWARE.test(m) || CODE_WORDS.test(m)) return true;
  for (const v of m.matchAll(CODE_VERB)) {
    // "Code a script that renames my files": whatever is coded is software.
    if (/^(code|program)$/i.test(v[0]) && /^\s+(a|an|me|my|our|the|this|some|it)\b/i.test(m.slice((v.index ?? 0) + v[0].length))) return true;
    if (SOFTWARE.test(madeThing(m.slice((v.index ?? 0) + v[0].length)))) return true;
  }
  return false;
}

/** Research that takes many searches, not one lookup: "deep research on…", "research
 *  every grant…", "compare 30 CRMs". One lookup ("research the best stroller") is a reply. */
const RESEARCH_AT_SCALE =
  /\b(deep research|deep[- ]dive|in-depth research|(thorough|comprehensive|exhaustive|extensive|full) (research|review|analysis|survey|scan|report)|market research|literature review|competitive (analysis|landscape|research)|research (every|each|all (of )?the)\b|(research|compare|review|analy[sz]e|find|list|look up|track down) (\d{2,}|dozens of|hundreds of|thousands of)\s|research (the|this) (whole|entire) (market|industry|field|space))/i;

/**
 * Work handed to agents, which costs more than an ordinary reply: a coding project
 * (software made or changed) or research at scale. Everything else is done inside the
 * reply. The caller leaves out maker lanes (a picture, a track, a video) and Lockdown,
 * where nothing goes to outside agents.
 */
export function handsToAgents(message: string): boolean {
  const m = String(message || "").trim();
  if (!m || asksAbout(m)) return false;
  return isCodeWork(m) || RESEARCH_AT_SCALE.test(m);
}

/** Every amount of money in a text: "$20", "$1,000", "$2k", "20 dollars", "50 bucks", "USD 30". */
function amountsIn(text: string): Array<{ dollars: number; index: number; end: number; bucks: boolean }> {
  const out: Array<{ dollars: number; index: number; end: number; bucks: boolean }> = [];
  const re = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)\s?(k|thousand)?\b|\b(\d[\d,]*(?:\.\d{1,2})?)\s?(k|thousand)?\s?(dollars?|bucks|usd)\b|\busd\s?(\d[\d,]*(?:\.\d{1,2})?)/gi;
  for (const m of text.matchAll(re)) {
    const raw = (m[1] ?? m[3] ?? m[6] ?? "").replace(/,/g, "");
    const n = Number(raw) * (m[2] || m[4] ? 1000 : 1);
    if (!raw || !Number.isFinite(n)) continue;
    out.push({ dollars: n, index: m.index ?? 0, end: (m.index ?? 0) + m[0].length, bucks: /bucks/i.test(m[5] ?? "") });
  }
  return out;
}

/** Said right before an amount, it makes the amount a limit on spending. */
const BUDGET_BEFORE =
  /\b(budget(ed)?|spend(ing)?|max(imum)?|at most|no more than|not more than|up to|under|below|less than|within|cap(ped)?|limit(ed)?|afford|have|got|keep (it|this|the cost|costs) (under|below|to))\b[^.!?\n$\d]{0,14}$/i;
/** Said right after an amount: "$30 max", "$50 budget", "$20 tops". */
const BUDGET_AFTER = /^\s*(budget|max(imum)?|tops|or less|at most|limit|cap|all in)\b/i;

/**
 * The most they said to spend, in dollars: the last amount in their words that reads
 * as a limit ("under $20", "50 bucks", "my budget is $200", "$30 max", or an answer
 * that starts with the amount, like a tapped "$50 — a solid start"). A price inside the
 * thing they want ("a shop for $20 T-shirts") is not a budget. `answer`: the text
 * replies to the budget question itself, so any amount in it counts, and a bare number
 * ("50") too. Digits only, like Code Monkey's check that the amount is in the person's
 * own words.
 */
export function budgetInWords(text: string, opts: { answer?: boolean } = {}): number | null {
  const t = String(text || "");
  let found: number | null = null;
  for (const a of amountsIn(t)) {
    const before = t.slice(Math.max(0, a.index - 40), a.index);
    const lineStart = /(^|\n)\s*$/.test(t.slice(0, a.index));
    // An answer to the budget question: any amount in it is the budget ("just go, $20").
    if (opts.answer || a.bucks || lineStart || BUDGET_BEFORE.test(before) || BUDGET_AFTER.test(t.slice(a.end, a.end + 20))) found = a.dollars;
  }
  if (found == null && opts.answer) {
    const bare = /^\s*(?:about|around|maybe|roughly|say|up to|under|max|at most|no more than)?\s*(\d[\d,]*(?:\.\d{1,2})?)\s?(k|thousand)?\b/i.exec(t);
    if (bare) {
      const n = Number(bare[1]!.replace(/,/g, "")) * (bare[2] ? 1000 : 1);
      if (Number.isFinite(n)) found = n;
    }
  }
  return found;
}

/** "$50", "$1,000", "$5.50". */
export function formatDollars(n: number): string {
  return "$" + (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}

/**
 * The budget's own numbers, in the same minutes as the rule above.
 *
 *   ask the budget  ⟺  P(guessing it wrong) × REDO[size] × STAKES[stakes] × CANT_UNDO
 *                        >  one tap × (hurried ? HURRY : 1)
 *
 * Money spent can't be taken back, so the can't-undo weight always applies; the answer
 * is one tap on a suggested amount. The smallest left side (0.67 × 0.5 × 1 × 10 = 3.33)
 * beats the largest right side (⅙ × 4 = 0.67), so work handed to agents with no
 * amount in their words always asks: the one question "just go" does not skip.
 */
export const BUDGET_RULE = {
  /** Three answers (a quick try, a solid start, lots of care): a guess at how much
   *  this matters to them is wrong two times in three. */
  P_GUESS_WRONG: 2 / 3,
  /** One tap on a suggested amount: about ten seconds. */
  TAP_MINUTES: 1 / 6,
} as const;

export function askBudget(
  a: Partial<Pick<Assessment, "size" | "stakes" | "hurried">>,
  o: { agentWork: boolean; budget?: number | null },
): AskOrGo {
  if (!o.agentWork) return { ask: false, costOfMisreading: 0, costOfAsking: 0, why: "budget: done inside a reply, nothing extra to spend" };
  if (o.budget != null) {
    return { ask: false, costOfMisreading: 0, costOfAsking: 0, why: `budget: ${formatDollars(o.budget)}, in their words` };
  }
  const k = ASK_OR_GO;
  const size = a.size ?? "small";
  const stakes = a.stakes ?? "play";
  const costOfMisreading = BUDGET_RULE.P_GUESS_WRONG * k.REDO_MINUTES[size] * k.STAKES_WEIGHT[stakes] * k.CANT_UNDO_WEIGHT;
  const costOfAsking = BUDGET_RULE.TAP_MINUTES * (a.hurried ? k.HURRY_WEIGHT : 1);
  const ask = costOfMisreading > costOfAsking;
  const r = (n: number) => Math.round(n * 100) / 100;
  const why =
    `budget ${ask ? "ask" : "go"}: ${r(BUDGET_RULE.P_GUESS_WRONG)} × ${k.REDO_MINUTES[size]} (${size}) × ${k.STAKES_WEIGHT[stakes]} (${stakes})` +
    ` × ${k.CANT_UNDO_WEIGHT} (can't undo) = ${r(costOfMisreading)} ${ask ? ">" : "≤"} ${r(costOfAsking)} (one tap${a.hurried ? ", hurried" : ""})`;
  return { ask, costOfMisreading: r(costOfMisreading), costOfAsking: r(costOfAsking), why };
}
