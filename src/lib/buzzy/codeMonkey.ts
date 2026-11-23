/**
 * Code Monkey's workshop — the policy half. Pure functions, no I/O.
 *
 * Code Monkey is BeeZilla's coding agent. A person describes what they want made
 * ("a bedtime adventure game for my kids", "a booking page for my salon") and the
 * workshop turns it into work that agents can do while the person gets on with
 * their life. The design follows what the strongest engineers converged on in
 * 2026 (docs/beezilla/CODE-MONKEY.md has the research and the why):
 *
 *   - Say the RESULT, not the plan. A result card holds who it is for, what
 *     changes for them, and "done when" checks that come back pass or fail.
 *     Nobody reads a plan up front; they look at proof afterwards.
 *   - Work in thin, end-to-end slices (tracer bullets), each something the
 *     person can see or try, with the order expressed as "after" links so
 *     independent slices can run at the same time.
 *   - Care scales with stakes. A bedtime game for two kids (play) is not a game
 *     for every kid in the world (product), and neither is a payments page
 *     (critical). The model proposes the tier; code only ever RAISES it.
 *   - Two-way doors (anything that can be undone) run without asking and show
 *     proof after. One-way doors (sending, paying, publishing, deleting,
 *     changing who can sign in) need the owner's explicit authorization: their
 *     own words in the request, or a go-ahead. Code decides which door a slice
 *     is; the model can only add caution, never remove it.
 *
 * The owner's decisions of 2026-11-23 (docs/beezilla/CODE-MONKEY.md, "Owner's decisions") add:
 *   - EVERY step gets an independent review by a model from a different
 *     company than the one that built it; when no such reviewer is set up, the
 *     step is reported "not independently reviewed", never "passed".
 *   - Verification means the running product: tests, then the app used like a
 *     person would, with screenshots or a short recording.
 *   - The first public launch needs the owner's OK unless they asked for it in
 *     so many words; after that the project's launch policy governs.
 *   - People see a plain checklist of steps; the dependency graph stays inside.
 *
 * Everything that can be wrong here is checked by scripts/test-code-monkey.ts.
 */

export type Stakes = "play" | "product" | "critical";
export type Door = "two-way" | "one-way";
/** What the person sees. Maps from the Dev Boards columns underneath. */
export type SliceState = "waiting" | "working" | "needs-you" | "checking" | "done";
export type ProofKind = "tests" | "try-it" | "screenshot" | "video" | "independent-review" | "security-check" | "undo-note";
/** What makes a one-way door one-way. `flagged` = the model asked for caution. */
export type DoorKind = "publish" | "message" | "money" | "delete" | "access" | "data" | "flagged";

export interface DoneCheck {
  /** One line that someone can answer yes or no to, in plain words. */
  text: string;
}

export interface ResultCard {
  /** What we're making, in the person's own words. */
  making: string;
  /** Who it is for. */
  forWhom: string;
  /** What changes for them when it exists. */
  outcome: string;
  /** 1–6 pass/fail checks for the whole thing. */
  doneWhen: DoneCheck[];
  /** What we are deliberately not doing (keeps scope honest). */
  notDoing: string[];
  stakes: Stakes;
  stakesWhy: string;
  /** Decisions Code Monkey made on the person's behalf, shown so they can change them. */
  assumptions: string[];
}

export interface SliceInput {
  /** Short key, unique within the project: "s1", "s2"… */
  key: string;
  /** What the person can do or see when this slice is done ("Play the first scene"). */
  title: string;
  /** How they try it ("open the link and tap Start"). */
  shows: string;
  doneWhen: DoneCheck[];
  /** Keys of slices that must be done first. */
  after: string[];
  /** The model may ask for extra caution. It can never lower what code decides. */
  oneWayHint?: boolean;
}

export interface Slice extends SliceInput {
  door: Door;
  /** Set for one-way slices: which kind of point of no return it is. */
  doorKind?: DoorKind;
  /** Why code chose that door, in plain words (empty for an ordinary two-way slice). */
  doorWhy: string;
}

export interface ReviewPolicy {
  /** Finished work goes straight to Done once its checks pass and proof is attached. */
  autoAccept: boolean;
  /** The owner looks before it counts as done (or before the irreversible step runs). */
  ownerLooks: boolean;
  /** A second model from a different provider reviews it with a fresh context. */
  independentReview: boolean;
  /** Evidence the worker must attach when it delivers. */
  proof: ProofKind[];
}

export const LIMITS = {
  doneChecks: { min: 1, max: 6 },
  sliceChecks: { min: 1, max: 4 },
  slices: { min: 1, max: 8 },
  assumptions: 8,
  text: 400,
} as const;

// ── Stakes ──────────────────────────────────────────────────────────────

const CRITICAL_SIGNALS: [RegExp, string][] = [
  [/\b(payments?|pay(ing)? (me|us|you)|charg(e|es|ing) (cards?|customers?|people)|credit cards?|stripe|checkout|invoic(e|es|ing)|payroll|bank(ing)?|money transfers?|refunds?)\b/i, "it handles money"],
  [/\b(medical|medicine|health (records?|data)|patients?|diagnos(is|e|tic)|prescri(be|ption)s?|therapy notes|clinic)\b/i, "it touches health information"],
  [/\b(legal (advice|documents?)|contracts?|compliance|gdpr|hipaa|coppa|tax (returns?|filing))\b/i, "it has legal or compliance weight"],
  [/\b(passwords?|log ?ins?|sign[- ]?ins?|authentication|permissions?|access control|encrypt(ion|ed)?|security)\b/i, "it decides who can get in"],
  [/\b(personal data|customer data|people'?s (data|details|information)|addresses and phone|social security|date of birth)\b/i, "it keeps other people's personal data"],
  [/\b(production (database|data|server|site)|live site|existing customers|real users'? data|migrat(e|ion) (the|our) data)\b/i, "it changes something people already rely on"],
  [/\b(safety|emergency|alarm|life[- ]critical|can'?t (go|be) wrong|devastating)\b/i, "a mistake would do real harm"],
];

const PRODUCT_SIGNALS: [RegExp, string][] = [
  [/\b(publish(ed|ing)?|launch(ed|ing)?|release (it|this)|ship (it|this) to)\b/i, "it will be published"],
  [/\b(app store|play store|google play|steam|itch\.io|product hunt)\b/i, "it goes to a public store"],
  [/\b(customers?|clients?|subscribers?|users|members|audience|everyone|kids everywhere|the public)\b/i, "other people will use it"],
  [/\b(sell|selling|business|my (shop|store|company|salon|restaurant|team)|revenue|startup)\b/i, "a business depends on it"],
];

const PLAY_SIGNALS: [RegExp, string][] = [
  [/\b(my (kids?|children|son|daughter|family|wife|husband|partner|friends?)|bedtime|for fun|just for me|for myself|hobby|toy|birthday|weekend project|to play with)\b/i, "it is for you and people close to you"],
  [/\b(try (an )?idea|prototype|sketch|throwaway|experiment|learn(ing)? to)\b/i, "it is an experiment"],
];

const RANK: Record<Stakes, number> = { play: 0, product: 1, critical: 2 };

function firstHits(text: string, signals: [RegExp, string][]): string[] {
  const out: string[] = [];
  for (const [re, why] of signals) if (re.test(text) && !out.includes(why)) out.push(why);
  return out;
}

/** The lowest tier the words allow, with the reasons. `play` hints never act as a floor. */
export function stakesFloor(text: string): { floor: Stakes; why: string[]; playHints: string[] } {
  const t = String(text || "");
  const critical = firstHits(t, CRITICAL_SIGNALS);
  if (critical.length) return { floor: "critical", why: critical, playHints: firstHits(t, PLAY_SIGNALS) };
  const product = firstHits(t, PRODUCT_SIGNALS);
  if (product.length) return { floor: "product", why: product, playHints: firstHits(t, PLAY_SIGNALS) };
  return { floor: "play", why: [], playHints: firstHits(t, PLAY_SIGNALS) };
}

/**
 * Settle the tier: the model's proposal, raised to the floor the words demand.
 * A model can be talked into "it's just a toy"; a regex cannot, which is the point.
 */
export function settleStakes(proposed: Stakes | undefined, text: string): { stakes: Stakes; raised: boolean; why: string[] } {
  const { floor, why } = stakesFloor(text);
  const p: Stakes = proposed && proposed in RANK ? proposed : "product";
  if (RANK[floor] > RANK[p]) return { stakes: floor, raised: true, why };
  return { stakes: p, raised: false, why };
}

// ── Doors ───────────────────────────────────────────────────────────────

const ONE_WAY_SIGNALS: [RegExp, string, DoorKind][] = [
  [/\b(delete|deletes|deleting|wipe|erase|drop (the )?(table|database)|overwrite|purge|remove (all|every|old) (data|records|users|files))\b/i, "it deletes or overwrites data", "delete"],
  [/\b(send(s|ing)?|e-?mail(s|ing)?|text(s|ing)?|notif(y|ies|ying)|messag(e|es|ing))\b[^.\n]{0,40}\b(e-?mails?|texts?|sms|messages?|newsletters?|invites?|invitations?|notifications?|subscribers?|customers?|users?|members?|everyone|people|parents|clients?)\b/i, "it sends messages to people", "message"],
  [/\b(charge|charges|charging|take payment|payout|refund|transfer money|bill (the|our) )/i, "it moves money", "money"],
  [/\b(publish|publishes|publishing|go live|goes live|deploy(s|ing)? to (production|the live|the public)|submit(s|ting)? to (the )?(app store|play store|steam)|post(s|ing)? (publicly|to (social|twitter|x|instagram|facebook|reddit)))\b/i, "it makes something public", "publish"],
  [/\b(change(s|ing)? (who can|permissions|passwords?)|reset (all )?passwords|revoke|grant (admin|access)|sign[- ]?in rules)\b/i, "it changes who can get in", "access"],
  [/\b(migrat(e|es|ing|ion)\b.*\b(data|database|users)|rename (a |the )?(column|table)s?)\b/i, "it reshapes stored data", "data"],
];

/** Code decides the door from the slice's own words; the model's hint can only add caution. */
export function doorFor(slice: Pick<SliceInput, "title" | "shows" | "doneWhen" | "oneWayHint">): { door: Door; why: string; kind?: DoorKind } {
  const text = [slice.title, slice.shows, ...(slice.doneWhen || []).map((c) => c.text)].join(" \n ");
  const hits = ONE_WAY_SIGNALS.filter(([re]) => re.test(text));
  if (hits.length) return { door: "one-way", why: [...new Set(hits.map((h) => h[1]))].join("; "), kind: hits[0][2] };
  if (slice.oneWayHint) return { door: "one-way", why: "Code Monkey flagged it as hard to undo", kind: "flagged" };
  return { door: "two-way", why: "" };
}

/**
 * The owner's own words can authorize a point of no return — "…and publish it",
 * "email my subscribers when it's ready". Only launching and messaging can be
 * authorized this way; money, deletion, sign-in and data changes always get their
 * own go-ahead (an inference about what they'd probably want is not authorization).
 * Only the owner's words count, never text the model wrote.
 */
const AUTHORIZING_WORDS: Partial<Record<DoorKind, RegExp>> = {
  publish: /\b(publish|launch|go live|make it live|put it (online|live|out there)|deploy it|release it|ship it|submit it to|put it on (the )?(app store|play store|steam|itch))\b/i,
  message: /\b(send|email|e-mail|text|message|notify)\b[^.?!\n]{0,40}\b(subscribers?|customers?|members?|parents|clients?|everyone|my list|mailing list)\b/i,
};

/** The sentence of the owner's words that authorizes this kind of step, or null. */
export function authorizedByWords(words: string, kind: DoorKind | undefined): string | null {
  const re = kind ? AUTHORIZING_WORDS[kind] : undefined;
  if (!re) return null;
  const t = String(words || "");
  const m = re.exec(t);
  if (!m) return null;
  // The sentence it sits in. A full stop only ends a sentence before a space or the end
  // (so "itch.io" stays whole).
  let from = 0;
  for (const e of t.slice(0, m.index).matchAll(/[.!?](\s|$)/g)) from = (e.index ?? 0) + 1;
  const after = /[.!?](\s|$)/.exec(t.slice(m.index + m[0].length));
  const end = after ? m.index + m[0].length + (after.index ?? 0) + 1 : t.length;
  return t.slice(from, end).trim().slice(0, 240);
}

// ── Who reviews: a different company than the one that built it ───────

const HARNESS_PROVIDER: Record<string, string> = {
  claude_code: "anthropic",
  codex: "openai",
  gemini_cli: "google",
  grok: "xai",
  xai: "xai",
  copilot: "github",
  cursor: "cursor",
  amp: "sourcegraph",
};

/** The company behind a harness's model. Harnesses that run any model (hermes, opencode…) need it named. */
export function providerOf(harness: string, named?: string): string | null {
  const n = String(named || "").trim().toLowerCase();
  if (n) return n;
  return HARNESS_PROVIDER[String(harness || "").trim().toLowerCase()] ?? null;
}

/** Independent only when both companies are known and they differ. Unknown is not independent. */
export function reviewIsIndependent(builder: string | null, reviewer: string | null): boolean {
  return Boolean(builder && reviewer && builder !== reviewer);
}

// ── Review policy ──────────────────────────────────────────────────────

/**
 * How much proof and whose eyes a slice needs. Every step is reviewed by a model
 * from another company (owner, 2026-11-23); proof grows with the stakes; a person
 * looks only at critical work and at points of no return they haven't authorized.
 */
export function reviewPolicy(stakes: Stakes, door: Door): ReviewPolicy {
  const proof: ProofKind[] =
    stakes === "critical" ? ["tests", "try-it", "screenshot", "video", "security-check", "independent-review", "undo-note"]
    : stakes === "product" ? ["tests", "try-it", "screenshot", "video", "independent-review"]
    : ["tests", "try-it", "screenshot", "independent-review"];
  if (door === "one-way" && !proof.includes("undo-note")) proof.push("undo-note");
  const ownerLooks = door === "one-way" || stakes === "critical";
  return { autoAccept: !ownerLooks, ownerLooks, independentReview: true, proof };
}

export const PROOF_WORDS: Record<ProofKind, string> = {
  tests: "test results (each done-when check, passed) — and the checks you ran on the real, running app",
  "try-it": "a link or steps to try the running app yourself",
  screenshot: "screenshots of the running app doing each done-when check",
  video: "a short screen recording of a person's path through it, start to finish",
  "independent-review": "a review by a model from a different company than the one that built it",
  "security-check": "what you checked for security (secrets, sign-in, other people's data) and what you found",
  "undo-note": "how to undo it if it goes wrong",
};

// ── Validation ─────────────────────────────────────────────────────────

/**
 * Checks a person can't answer yes or no to. "Is it professional?" can't fail,
 * so it can't guide the work; "every page loads in under 2 seconds" can.
 */
const VAGUE = /\b(looks? (good|great|nice|right|professional)|professional|polished|clean|nice|beautiful|modern|intuitive|user[- ]friendly|easy to use|high[- ]quality|robust|scalable|seamless|best practices?|works? (well|properly|correctly)|good ux|feels? (good|right))\b/i;

export function isVagueCheck(text: string): boolean {
  const t = String(text || "").trim();
  if (t.length < 8) return true;
  if (!VAGUE.test(t)) return false;
  // A vague word next to something measurable is fine: "loads fast — under 2 seconds".
  return !/\d|\b(every|each|no|none|all|without|only|at least|at most|under|over|within)\b/i.test(t);
}

function clip(s: unknown, n: number = LIMITS.text): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}

export function normalizeCard(raw: Partial<ResultCard> & Record<string, unknown>): ResultCard {
  const list = (v: unknown, n: number) => (Array.isArray(v) ? v : []).map((x) => clip(typeof x === "string" ? x : (x as DoneCheck)?.text)).filter(Boolean).slice(0, n);
  const stakes = (["play", "product", "critical"] as Stakes[]).includes(raw.stakes as Stakes) ? (raw.stakes as Stakes) : "product";
  return {
    making: clip(raw.making, 160),
    forWhom: clip(raw.forWhom, 160),
    outcome: clip(raw.outcome, 240),
    doneWhen: list(raw.doneWhen, LIMITS.doneChecks.max).map((text) => ({ text })),
    notDoing: list(raw.notDoing, 8),
    stakes,
    stakesWhy: clip(raw.stakesWhy, 240),
    assumptions: list(raw.assumptions, LIMITS.assumptions),
  };
}

export function validateCard(card: ResultCard): string[] {
  const problems: string[] = [];
  if (!card.making) problems.push("Say what we're making.");
  if (!card.forWhom) problems.push("Say who it is for.");
  if (!card.outcome) problems.push("Say what changes for them when it exists.");
  if (card.doneWhen.length < LIMITS.doneChecks.min) problems.push("Add at least one 'done when' check.");
  for (const c of card.doneWhen) {
    if (isVagueCheck(c.text)) problems.push(`"${c.text}" can't pass or fail — say what someone would see or measure.`);
  }
  return problems;
}

export function normalizeSlices(raw: unknown): SliceInput[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.slice(0, LIMITS.slices.max).map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const key = clip(o.key, 12).toLowerCase().replace(/[^a-z0-9_-]/g, "") || `s${i + 1}`;
    const checks = (Array.isArray(o.doneWhen) ? o.doneWhen : [])
      .map((c) => clip(typeof c === "string" ? c : (c as DoneCheck)?.text))
      .filter(Boolean)
      .slice(0, LIMITS.sliceChecks.max)
      .map((text) => ({ text }));
    const after = (Array.isArray(o.after) ? o.after : []).map((k) => clip(k, 12).toLowerCase()).filter(Boolean);
    return { key, title: clip(o.title, 140), shows: clip(o.shows, 240), doneWhen: checks, after, oneWayHint: o.oneWayHint === true };
  });
}

/** A slice named after a layer ("Set up the database") with nothing to see is a horizontal slice. */
const LAYER_ONLY = /^(set ?up|setup|create|build|write|add|make|design|configure|install)\s+(the\s+|a\s+|an\s+)?(database|db|schema|tables?|api|backend|back[- ]end|server|models?|types?|tests?|test suite|infrastructure|project structure|boilerplate|architecture)\b/i;

export function validateSlices(slices: SliceInput[]): string[] {
  const problems: string[] = [];
  if (slices.length < LIMITS.slices.min) problems.push("Cut the work into at least one slice.");
  const keys = new Set<string>();
  for (const s of slices) {
    if (keys.has(s.key)) problems.push(`Two slices share the key ${s.key}.`);
    keys.add(s.key);
    if (!s.title) problems.push(`Slice ${s.key} needs a title that says what the person can do or see.`);
    if (!s.shows) problems.push(`Slice ${s.key} needs a way to try it (a link, a screen, a button to press).`);
    if (s.doneWhen.length < LIMITS.sliceChecks.min) problems.push(`Slice ${s.key} needs a 'done when' check.`);
    for (const c of s.doneWhen) if (isVagueCheck(c.text)) problems.push(`Slice ${s.key}: "${c.text}" can't pass or fail.`);
    if (LAYER_ONLY.test(s.title)) problems.push(`Slice ${s.key} ("${s.title}") is one layer, not something to try — cut it end to end.`);
  }
  for (const s of slices) {
    for (const a of s.after) {
      if (!keys.has(a)) problems.push(`Slice ${s.key} waits for ${a}, which doesn't exist.`);
      if (a === s.key) problems.push(`Slice ${s.key} waits for itself.`);
    }
  }
  if (!problems.length && topoOrder(slices) === null) problems.push("The slices wait on each other in a circle.");
  if (slices.length && !slices.some((s) => s.after.length === 0)) problems.push("At least one slice must be able to start straight away.");
  return problems;
}

/** Keys in an order where every slice comes after the ones it waits for; null on a cycle. */
export function topoOrder(slices: Pick<SliceInput, "key" | "after">[]): string[] | null {
  const pending = new Map(slices.map((s) => [s.key, new Set(s.after)]));
  const order: string[] = [];
  while (pending.size) {
    const ready = [...pending.entries()].filter(([, deps]) => [...deps].every((d) => !pending.has(d))).map(([k]) => k);
    if (!ready.length) return null;
    for (const k of ready) {
      order.push(k);
      pending.delete(k);
    }
  }
  return order;
}

export function settleSlices(raw: SliceInput[]): Slice[] {
  return raw.map((s) => {
    const { door, why, kind } = doorFor(s);
    return kind ? { ...s, door, doorWhy: why, doorKind: kind } : { ...s, door, doorWhy: why };
  });
}

// ── State ──────────────────────────────────────────────────────────────

/** Dev Boards column → what the person sees. "blocked" is only ever used here for "waiting on another slice". */
export function stateFromColumn(column: string): SliceState {
  switch (column) {
    case "running":
      return "working";
    case "needs_human":
      return "needs-you";
    case "review":
      return "checking";
    case "done":
      return "done";
    default:
      return "waiting";
  }
}

/** Slices whose every "after" is done and that are still parked: these move to Ready. */
export function slicesToRelease(slices: Pick<SliceInput, "key" | "after">[], columnOf: Record<string, string>): string[] {
  return slices
    .filter((s) => columnOf[s.key] === "blocked" && s.after.length > 0 && s.after.every((a) => columnOf[a] === "done"))
    .map((s) => s.key);
}

// ── The brief each worker agent gets ───────────────────────────────────

export interface MissionBrief {
  title: string;
  objective: string;
  context: string;
  constraints: string;
  acceptance: string;
  tags: string[];
}

/**
 * Written the way top engineers brief a capable coworker: the task, the
 * guardrails, what done looks like and the proof to bring back. No role-play,
 * no capital-letter rules — those make current models over-apply instructions.
 */
export function missionBrief(card: ResultCard, slice: Slice, allSlices: Slice[], authorizedBy?: string | null): MissionBrief {
  const policy = reviewPolicy(card.stakes, slice.door);
  const waitsFor = slice.after
    .map((k) => allSlices.find((s) => s.key === k))
    .filter(Boolean)
    .map((s) => `"${s!.title}"`);
  const lines = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
  const constraints = [
    card.notDoing.length ? `Not part of this project:\n${lines(card.notDoing)}` : "",
    card.assumptions.length ? `Already decided for the owner (keep these unless a done check can't pass):\n${lines(card.assumptions)}` : "",
    slice.door === "one-way"
      ? `This slice is hard to undo (${slice.doorWhy}). Build and test everything, but do not run the irreversible step itself — deliver it ready. ` +
        (authorizedBy
          ? `The owner already asked for it in their own words ("${authorizedBy}"), so once the independent review passes you will be told to go ahead.`
          : "It runs only after the independent review passes and the owner says go ahead.")
      : "This slice can be undone, so make reasonable decisions yourself and note them in your delivery instead of asking.",
    "Test it the way the owner will use it: run the real app and go through each done check like a person would, not only unit tests.",
    "If a done check truly can't pass without the owner, escalate ONE short question with your recommended answer; otherwise keep going.",
    "Leave the codebase easier to change than you found it: match existing patterns and names, and turn any fix for a repeated mistake into a test or lint check rather than a comment.",
  ].filter(Boolean);
  return {
    title: slice.title.slice(0, 120),
    objective: `${slice.title}. The owner tries it by: ${slice.shows}`,
    context: [
      `Project: ${card.making} — for ${card.forWhom}.`,
      `Why it matters: ${card.outcome}`,
      `Stakes: ${card.stakes}${card.stakesWhy ? ` (${card.stakesWhy})` : ""}.`,
      waitsFor.length ? `Builds on: ${waitsFor.join(", ")}.` : "This is a first slice: get something the owner can try, end to end, before polishing anything.",
    ].join("\n"),
    constraints: constraints.join("\n\n"),
    acceptance: [
      "Done when (each must pass):",
      lines(slice.doneWhen.map((c) => c.text)),
      "",
      "Attach as proof:",
      lines(policy.proof.map((p) => PROOF_WORDS[p])),
      "",
      "Write your delivery for someone who never watched you work: the most important thing first, in plain words, " +
        "then what changed, what you decided and why, and anything you did NOT verify. Keep going until every check passes; " +
        "don't stop to list what's left or to ask whether to continue.",
    ].join("\n"),
    tags: ["code-monkey", `slice:${slice.key}`, `door:${slice.door}`, `stakes:${card.stakes}`, ...slice.after.map((a) => `after:${a}`)],
  };
}

// ── Talk: when Code Monkey's tool is offered, and what the model is told ──

/**
 * A request to MAKE or CHANGE software — the only turns that get the
 * start_code_project tool. Talking about code ("what is Python?") is not one.
 */
export function isCodeRequest(message: string): boolean {
  const m = String(message || "");
  const thing = "(app|apps|game|games|website|web ?site|site|web page|webpage|landing page|page|tool|script|bot|chatbot|extension|plug-?in|program|dashboard|api|backend|database|feature|prototype|widget|calculator|tracker|form|portfolio|shop|store front|storefront)";
  return (
    new RegExp(`\\b(build|make|create|code|program|develop|write|design|set up|put together|spin up)\\b[^.?!\\n]{0,60}\\b${thing}\\b`, "i").test(m) ||
    new RegExp(`\\b(add|change|fix|update|improve)\\b[^.?!\\n]{0,40}\\b(my|the|our|this)\\s+(${thing.slice(1, -1)}|code|codebase|repo|repository)\\b`, "i").test(m) ||
    /\b(fix (the|a|this) bug|debug (my|the|this)|refactor|deploy (my|the|this)|code monkey)\b/i.test(m)
  );
}

/** The one tool Talk gets for coding work. The schema mirrors ResultCard + SliceInput. */
export const START_CODE_PROJECT_TOOL = {
  type: "function",
  function: {
    name: "start_code_project",
    description:
      "Start a coding project in Code Monkey's workshop when the owner wants software made or changed. " +
      "Describe the RESULT (who it is for, what changes for them, checks that pass or fail), never a plan. " +
      "Cut the work into 1-8 thin slices that each work end to end and can be tried; use `after` only when one slice truly needs another first. " +
      "Decide reasonable details yourself and list them as assumptions instead of asking. " +
      "Set each check's bar as high as the owner would want — agents keep working until they reach it.",
    parameters: {
      type: "object",
      properties: {
        making: { type: "string", description: "What we're making, in the owner's words." },
        forWhom: { type: "string", description: "Who it is for." },
        outcome: { type: "string", description: "What changes for them when it exists." },
        doneWhen: { type: "array", items: { type: "string" }, description: "1-6 checks someone can answer yes or no, e.g. 'Tapping Start shows the first scene on an iPad'." },
        notDoing: { type: "array", items: { type: "string" }, description: "What is deliberately out of scope." },
        stakes: { type: "string", enum: ["play", "product", "critical"], description: "play = for the owner and people close to them; product = other people will use it; critical = money, health, sign-in, other people's data, or harm if wrong." },
        stakesWhy: { type: "string" },
        assumptions: { type: "array", items: { type: "string" }, description: "Decisions you made for the owner, so they can change them." },
        slices: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: "s1, s2, …" },
              title: { type: "string", description: "What the owner can do or see when it is done." },
              shows: { type: "string", description: "How they try it." },
              doneWhen: { type: "array", items: { type: "string" } },
              after: { type: "array", items: { type: "string" }, description: "Keys that must be done first." },
              oneWayHint: { type: "boolean", description: "true if this slice does something that can't be undone." },
            },
            required: ["key", "title", "shows", "doneWhen"],
          },
        },
      },
      required: ["making", "forWhom", "outcome", "doneWhen", "stakes", "slices"],
    },
  },
} as const;

/** Split the tool's flat arguments into the card and the slices. */
export function argsToProject(args: Record<string, unknown>): { card: Record<string, unknown>; slices: unknown } {
  const { slices, ...card } = args || {};
  return { card, slices };
}

/** Appended to the system prompt on coding turns only. Short on purpose: the tool description carries the rest. */
export const CODE_MONKEY_GUIDE = [
  "Coding turn: if the owner wants software made or changed, call start_code_project once the result is clear enough to build.",
  "Clear or undoable work: just start it. Only ask first when the request is genuinely unclear AND significant, and then ask one quick choice: a few questions first, or just go for it?",
  "After starting, tell the owner in one or two sentences what is being made and that they can watch it in the workshop; do not paste the slices back.",
].join(" ");

export function codeProjectStartedMessage(view: { jobId: string; card: ResultCard; slices: { title: string }[]; stakesRaisedFrom?: Stakes }): string {
  const raised = view.stakesRaisedFrom ? ` Stakes were raised from ${view.stakesRaisedFrom} to ${view.card.stakes} because ${view.card.stakesWhy}; mention this in one short clause.` : "";
  return `start_code_project: started "${view.card.making}" as ${view.slices.length} slice(s), stakes ${view.card.stakes}. ` +
    `Agents are picking it up now; the owner sees progress and proof in Code Monkey's workshop (a card under your reply opens it).${raised}`;
}

export function codeProjectRefusedMessage(problems: string[]): string {
  return `start_code_project was not started — fix these and call it again: ${problems.slice(0, 6).join(" ")}`;
}
