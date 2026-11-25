import type { Sql } from "@/lib/db";
import {
  QUESTION,
  askBudget,
  askFirst,
  budgetInWords,
  formatDollars,
  startsNewRequest,
  askPreferenceKey,
  askPreferenceText,
  readAskPreference,
  type AskOrGo,
  type AskPreference,
  type Assessment,
  type Stakes,
} from "./askOrGo";

/**
 * One mode: BeeZilla decides, per request, whether to ask first or just go.
 *
 * There used to be two ways of working. "Chat" asked a question or two about the end
 * result before building anything bigger; "Work" ran a scripted interview (four
 * decisions, then budget, timing and exclusions), asked "does this plan look right?"
 * before a multi-part job, and offered to "define the work" once a chat looked like a
 * project. Owner, 2026-11-23: one mode, optimised for people's satisfaction over the
 * long haul. Any friction (a question, an approval, a plan to read) has to be
 * justified, because over-cautious tools waste people's time, which is why most people
 * end up switching their safeguards off.
 *
 * So, for every request:
 *   1. Silently assess its size, how easily it could be misread, and its stakes
 *      (play, product or critical). `assessRequest` in askOrGo.ts.
 *   2. Weigh the cost of misreading it against the cost of asking: `askOrGo`, the
 *      equation in askOrGo.ts. Everything in this file serves it. A person's answer
 *      to the quick choice is remembered per stakes tier: asked once, then not again.
 *   3. Clear or small: just do it, then show proof and the assumptions it made.
 *   4. Significant and easy to misread: ONE quick choice first, "I can ask a few
 *      questions before I start, or just go for it — which do you prefer?"
 *   5. Questions accepted: the fewest that matter, one at a time, each with
 *      BeeZilla's suggested answer so one tap accepts it. The first two are always
 *      "What problem are you trying to solve?" and "What would make you (or your
 *      team) incredibly satisfied with how this turns out?". Then the result is
 *      written down like an agile ticket (who it is for, the outcome, done when)
 *      and the work starts, aimed at the result rather than the first idea of how.
 *   6. Work handed to agents (a coding project, research at scale) costs more than a
 *      reply, so before it starts they say how much to spend: an amount already in
 *      their words is used as it is; otherwise ONE question with three tap answers
 *      sized to the stakes. In the questions it comes right after the two openers;
 *      after "just go" it is the one question that survives (money spent can't be
 *      taken back: `askBudget` in askOrGo.ts). Owner, 2026-11-23: "No bankrupting
 *      people for small projects."
 *   7. Questions reveal the why and the walls (time, money, who it is for, what must
 *      never happen), never the product: features, looks and technology are
 *      BeeZilla's to decide, and their idea of what to make is a starting point,
 *      kept in the ticket apart from the why.
 *
 * Everything here is pure except `interviewQuestion`, which takes its model call as
 * a parameter, so the whole of the behaviour is testable without a network
 * (scripts/test-one-mode.ts).
 *
 * This is a different axis from the privacy modes (Open, Advocate, Lockdown): those
 * decide what may leave BeeZilla; this decides when BeeZilla stops to ask.
 */

// ── 1. The conversation: offer, questions, ticket ──────────────────────

/** The one quick choice, in the owner's words. */
export const OFFER_TEXT = "I can ask a few questions before I start, or just go for it — which do you prefer?";

/** The two answers to the choice, as buttons. `send` is what goes on the record. */
export const OFFER_OPTIONS: ChoiceOption[] = [
  { label: "Ask me a few questions", send: "Ask me a few questions", value: "ask" },
  { label: "Just go for it", send: "Just go for it", value: "go" },
];

/** Every interview opens with these two (owner, 2026-11-23). */
export const OPENING_QUESTIONS = [
  "What problem are you trying to solve?",
  "What would make you (or your team) incredibly satisfied with how this turns out?",
] as const;

/** The two openers plus at most three questions whose answers change the result. */
export const MAX_QUESTIONS = 5;

/** How much to spend, word for word (owner, 2026-11-23); Code Monkey's budget.ts
 *  (#372) asks with the same words and amounts. */
export const BUDGET_QUESTION = "How much should I spend on this, at most? I'll keep my work under that amount.";

/** Its three tap answers per stakes tier; the middle one is suggested. */
export const BUDGET_ANSWERS: Readonly<Record<Stakes, readonly [string, string, string]>> = {
  play: ["$2 — a quick try", "$5 — a solid start", "$20 — lots of care"],
  product: ["$20 — a quick try", "$50 — a solid start", "$200 — lots of care"],
  critical: ["$100 — a quick try", "$200 — a solid start", "$1,000 — lots of care"],
};

/** The suggested amount for a tier: the middle answer. */
export function budgetSuggestion(stakes: Stakes = "play"): string {
  return BUDGET_ANSWERS[stakes][1];
}

/** The three amounts as buttons, the suggested one marked. A tap sends the amount as
 *  their own words, so it is the person who names it, never BeeZilla. */
export function budgetOptions(stakes: Stakes = "play"): ChoiceOption[] {
  return BUDGET_ANSWERS[stakes].map((label, i) => ({ label, send: label, value: "amount" as const, ...(i === 1 ? { suggested: true } : {}) }));
}

/** Where the person is in the ask-first path. Kept per conversation. */
export interface OneModeState {
  /** offered: the quick choice is waiting. asking: the questions. budget: only the
   *  budget question, then the work. */
  stage: "offered" | "asking" | "budget";
  /** The request the questions are about, in their words. */
  request: string;
  /** Its stakes tier: their answer to the choice is remembered for this tier. */
  stakes?: Stakes;
  /** Questions asked so far, each with the suggested answer shown under it. */
  asked: Array<{ q: string; suggested: string }>;
  /** Their answers, in order (a tapped suggestion is recorded as that suggestion). */
  answers: string[];
  /** Times it was carried past an unrelated request (once at most, then let go). */
  carried?: number;
  /** The request hands work to agents (askOrGo.handsToAgents): it needs a budget. */
  agentWork?: boolean;
  /** The most they said to spend, in dollars, once they have said it. */
  budget?: number;
}

export interface ChoiceOption {
  label: string;
  /** The words sent as their message when the button is pressed. */
  send: string;
  value: "ask" | "go" | "accept" | "amount";
  /** BeeZilla's suggestion among several answers (drawn as the main button). */
  suggested?: boolean;
}

/** The request and what they answered, handed to the turn that does the work. */
export interface Interview {
  request: string;
  qa: Array<{ q: string; a: string }>;
}

/** How a go turn came about. fresh: the rule said go. skipped: they chose "just go".
 *  ticket: the questions are done and the ticket is written before the work. budget:
 *  the budget question was the one thing asked, and now the work. */
export type GoHow = "fresh" | "skipped" | "ticket" | "budget";

/** What the turn does. */
export type OneModeStep =
  /** Do it now. `agentWork`: it goes to agents, so it needs `budget` (dollars) to
   *  spend anything; without one, only what fits in a reply goes ahead. */
  | { kind: "go"; how: GoHow; interview?: Interview; agentWork?: boolean; budget?: number }
  /** Offer the one quick choice. */
  | { kind: "offer" }
  /** Ask question `index` (0-based). */
  | { kind: "ask"; index: number }
  /** Ask how much to spend (BUDGET_QUESTION), with three tap answers. */
  | { kind: "budget" };

export interface StepInput {
  message: string;
  /** Do it, or the "Just go for it" button. */
  execute?: boolean;
  /** The button they pressed under BeeZilla's last reply, if any. */
  choice?: "ask" | "go" | "accept" | "amount" | null;
  /** The rule's verdict on this message as a fresh request. */
  fresh: AskOrGo;
  /** This message's assessment (its stakes tier, a one-way door; size and hurry for
   *  the budget's numbers). */
  assessment?: Pick<Assessment, "stakes" | "irreversible"> & Partial<Pick<Assessment, "size" | "hurried">>;
  /** This message hands work to agents (askOrGo.handsToAgents; never a maker lane). */
  agentWork?: boolean;
  /** An amount they set earlier in this conversation, in dollars. */
  knownBudget?: number | null;
  /** What they answered to "questions first, or just go?" for this tier before. */
  remembered?: AskPreference | null;
  /** A maker lane (picture, track, 3D, video) handles this message: its own work. */
  makerLane?: boolean;
  /** The page builds (or opens) an orchestration on the Idea Board this turn (pilot.ts
   *  asksToOrchestrate). That build is the go: one model call, shown card by card and
   *  taken back with ⌘Z, and the reply is one sentence ("don't ask me anything first").
   *  Nothing is asked, no budget, and a question still waiting stays as it was. */
  buildsOnBoard?: boolean;
  /** The conversation has an id, so the next turn can find this one's state. */
  canFollowUp: boolean;
}

/** An answer to "questions first, or just go?" worth keeping for its tier. */
export interface Remember {
  stakes: Stakes;
  pref: AskPreference;
}

export interface StepResult {
  step: OneModeStep;
  state: OneModeState | null;
  /** Keep this answer for the tier, so next time nobody has to ask. Only ever their
   *  own explicit answer (a button, "just go", "ask me questions"), never an inference. */
  remember?: Remember;
  /** An unrelated request went ahead while a question was waiting: the waiting
   *  question is still open, and goes under this reply again (once). */
  carry?: boolean;
}

/** Said under every turn that waits on the person (owner, 2026-11-23: a pending answer
 *  never stalls unrelated work, and a waiting turn says what keeps going). */
export const WAITING_NOTE = "Anything else you ask meanwhile goes ahead.";

/** "Just go", "go for it", "skip the questions", "cut to the chase"… */
export function isGoReply(message: string): boolean {
  const m = String(message || "").trim();
  return (
    /^\s*(just )?go[.!]*\s*$/i.test(m) ||
    /\bthat'?s enough[.!]*$/i.test(m) ||
    /\b(just go( for it| ahead)?|go for it|go ahead|just do it|do it now|just (make|build|write|start|do) it|skip (the|these|your|any)?\s*questions|no (more )?questions|stop asking|enough questions|that'?s enough questions|cut to the chase|get (it|the job) done|i'?m in a hurry|no time for questions)\b/i.test(m)
  );
}

/** "You decide", "up to you", "surprise me": they hand the decision to BeeZilla. To
 *  the quick choice that means go; to a question it means take the suggestion. */
export function isDelegateReply(message: string): boolean {
  return /\b(you decide|you choose|you pick|up to you|your call|surprise me|dealer'?s choice|whatever you think( is best)?|i trust you)\b/i.test(
    String(message || ""),
  );
}

/** "Ask me", "questions first", "questions": they name the questions themselves. */
export function isExplicitAskReply(message: string): boolean {
  const m = String(message || "").trim();
  if (isGoReply(m)) return false;
  return (
    /\b(ask (me )?(a few |some |your |the )?(questions?|away|first)|questions? first|(a few|some) questions|ask first|let'?s do (the )?questions|interview me)\b/i.test(m) ||
    /^(questions?|ask( me)?)[.!]*$/i.test(m)
  );
}

/** An explicit ask, or a bare yes to "I can ask a few questions…" (taken as the
 *  first option this time, but never remembered: a bare yes is ambiguous). */
export function isAskReply(message: string): boolean {
  const m = String(message || "").trim();
  if (isGoReply(m)) return false;
  return isExplicitAskReply(m) || /^(yes|yeah|yep|yup|sure|ok|okay|please|fine|alright|all right|sounds good)[.!]*$/i.test(m);
}

/** Takes the suggested answer: a bare yes, "use that", "that's right"… */
export function isAcceptReply(message: string): boolean {
  const m = String(message || "").trim();
  return /^(yes|yeah|yep|yup|sure|ok|okay|correct|right|exactly|true|perfect|sounds (good|right)|that'?s (it|right|correct|fine)|use (that|it|the suggestion|your suggestion)|that one|agreed|fine)[.!]*$/i.test(m);
}

/** A request that asks for the questions up front: "…, ask me some questions first". */
export function wantsQuestionsFirst(message: string): boolean {
  return /\b(ask me (a few |some |any )?questions( first)?|questions first|interview me( first)?)\b/i.test(String(message || ""));
}

/** A real question back at BeeZilla, mid-interview: they changed course. */
function isQuestionBack(message: string): boolean {
  const m = String(message || "").trim();
  return QUESTION.test(m) && /\?\s*$/.test(m);
}

/** The questions asked so far, each with its answer. */
export function interviewOf(state: OneModeState): Interview {
  return {
    request: state.request,
    qa: state.answers.map((a, i) => ({ q: state.asked[i]?.q ?? "", a })).filter((x) => x.q),
  };
}

/** Their words as typed, kept whole (only the ends trimmed) up to a generous cap. */
const REQUEST_MAX = 4000;

/** What the budget rule needs from the turn. */
export interface BudgetContext {
  message: string;
  /** An amount they set earlier in this conversation, in dollars. */
  knownBudget?: number | null;
  canFollowUp: boolean;
  assessment?: StepInput["assessment"];
}

/** The most they said to spend on the request in `s`: their answer to the budget
 *  question, an amount anywhere in the request, their answers or this message, or one
 *  they set earlier in the conversation. */
function budgetFor(s: OneModeState | null, ctx: BudgetContext): number | null {
  if (s?.budget != null) return s.budget;
  return budgetInWords([s?.request ?? "", ...(s?.answers ?? []), ctx.message].join("\n")) ?? ctx.knownBudget ?? null;
}

/** Work handed to agents with no amount yet: ask how much to spend (askOrGo.askBudget). */
function needsBudget(s: OneModeState | null, agentWork: boolean, ctx: BudgetContext): boolean {
  const a = ctx.assessment;
  return askBudget({ size: a?.size, stakes: s?.stakes ?? a?.stakes, hurried: a?.hurried }, { agentWork, budget: budgetFor(s, ctx) }).ask;
}

/**
 * Go on the request in `s` (the questions are over, or they said "just go"), with its
 * budget when there is one. Work handed to agents with no amount still goes as far as
 * a reply goes (nothing that costs money starts), and the budget question stays open
 * under it, once: a pending answer never stalls the rest.
 */
export function goOnRequest(s: OneModeState, how: GoHow, ctx: BudgetContext, remember?: Remember): StepResult {
  const budget = budgetFor(s, ctx);
  const out: StepResult = {
    step: {
      kind: "go",
      how,
      interview: interviewOf(s),
      ...(s.agentWork ? { agentWork: true } : {}),
      ...(budget != null ? { budget } : {}),
    },
    state: null,
  };
  if (remember) out.remember = remember;
  if (s.agentWork && budget == null && ctx.canFollowUp && (s.stage !== "budget" || (s.carried ?? 0) < 1)) {
    out.state = { ...s, stage: "budget", carried: 1 };
    out.carry = true;
  }
  return out;
}

/**
 * The next step, from where the conversation is and what they just said.
 *
 * Pure: the caller persists the returned state and, for an `ask` step, adds the
 * question it actually asked to `asked` (the budget question is added here).
 */
export function nextStep(state: OneModeState | null, input: StepInput): StepResult {
  // Built on the board this turn: the reply carries the page's actions, and a quick
  // choice would come back without them, so the board would never build.
  if (input.buildsOnBoard) return { step: { kind: "go", how: "fresh" }, state };
  // Their own explicit "go": the button, Do it, or the words. "You decide" also means
  // go this time, but it hands the choice over, so it is never remembered.
  const goExplicit = input.execute === true || input.choice === "go" || isGoReply(input.message);
  const delegates = isDelegateReply(input.message);
  const keep = (stakes: Stakes | undefined, pref: AskPreference): Remember | undefined =>
    stakes ? { stakes, pref } : undefined;
  // Something else entirely, asked while a question waits: it goes ahead now, and the
  // waiting question stays open (carried under the reply once, then let go).
  const unrelated = (pending: OneModeState) =>
    !goExplicit && (isQuestionBack(input.message) || input.makerLane === true || startsNewRequest(input.message, pending.request));
  const carryOrDrop = (pending: OneModeState): StepResult =>
    (pending.carried ?? 0) < 1
      ? { step: { kind: "go", how: "fresh" }, state: { ...pending, carried: (pending.carried ?? 0) + 1 }, carry: true }
      : { step: { kind: "go", how: "fresh" }, state: null };
  const ctx: BudgetContext = {
    message: input.message,
    knownBudget: input.knownBudget,
    canFollowUp: input.canFollowUp,
    assessment: input.assessment,
  };
  // The go path: the budget question on its own, then the work, no other question.
  const budgetFirst = (s: OneModeState, remember?: Remember): StepResult => {
    const out: StepResult = { step: { kind: "budget" }, state: { ...s, stage: "budget", carried: 0 } };
    if (remember) out.remember = remember;
    return out;
  };

  if (state?.stage === "budget") {
    // A tapped or typed amount ("$50 — a solid start", "50", "under 30 bucks"): go.
    const dollars = budgetInWords(input.message, { answer: true });
    if (dollars != null) return goOnRequest({ ...state, budget: dollars }, "budget", ctx);
    if (unrelated(state)) return carryOrDrop(state);
    // No amount ("just go", "you decide", "not sure", more about the work): an amount
    // is theirs to name, never BeeZilla's guess, so what fits in a reply goes ahead now
    // and the question stays open, once.
    if ((state.carried ?? 0) < 1) return goOnRequest(state, "budget", ctx);
    return { step: { kind: "go", how: "fresh" }, state: null };
  }

  if (state?.stage === "offered") {
    if (goExplicit || delegates) {
      const remember = goExplicit ? keep(state.stakes, "go") : undefined;
      if (input.canFollowUp && needsBudget(state, state.agentWork === true, ctx)) return budgetFirst(state, remember);
      return goOnRequest(state, "skipped", ctx, remember);
    }
    if (input.choice === "ask" || isAskReply(input.message)) {
      return {
        step: { kind: "ask", index: 0 },
        state: { ...state, stage: "asking", asked: [], answers: [] },
        remember: input.choice === "ask" || isExplicitAskReply(input.message) ? keep(state.stakes, "ask") : undefined,
      };
    }
    if (unrelated(state)) return carryOrDrop(state);
    // More detail about the same request instead of a choice: never offer twice in a
    // row, go with everything they said as context.
    return { step: { kind: "go", how: "fresh" }, state: null };
  }

  if (state?.stage === "asking") {
    const last = state.asked[state.asked.length - 1];
    const atBudget = last?.q === BUDGET_QUESTION;
    if (goExplicit) {
      // Declining before answering anything is the same as answering the choice "go".
      const remember = state.answers.length === 0 ? keep(state.stakes, "go") : undefined;
      // "Just go, $20" answers the budget question as well.
      const dollars = atBudget ? budgetInWords(input.message, { answer: true }) : null;
      const s = dollars != null ? { ...state, budget: dollars } : state;
      if (!atBudget && input.canFollowUp && needsBudget(s, s.agentWork === true, ctx)) return budgetFirst(s, remember);
      return goOnRequest(s, "skipped", ctx, remember);
    }
    if (unrelated(state)) return carryOrDrop(state);
    const said = String(input.message || "").trim();
    // An amount is their own: a bare yes or "you decide" never picks one for them.
    const tookSuggestion = !atBudget && (input.choice === "accept" || isAcceptReply(said) || delegates) && !!last?.suggested;
    const answers = [...state.answers, tookSuggestion ? last!.suggested : said];
    const dollars = atBudget ? budgetInWords(said, { answer: true }) : null;
    const answered: OneModeState = { ...state, answers, carried: 0, ...(dollars != null ? { budget: dollars } : {}) };
    if (answers.length >= MAX_QUESTIONS) return goOnRequest(answered, "ticket", ctx);
    // Right after the two openers: how much to spend, when the work goes to agents and
    // no amount is known yet. Asked once.
    if (
      answers.length === OPENING_QUESTIONS.length &&
      input.canFollowUp &&
      !answered.asked.some((a) => a.q === BUDGET_QUESTION) &&
      needsBudget(answered, answered.agentWork === true, ctx)
    ) {
      return {
        step: { kind: "budget" },
        state: { ...answered, asked: [...answered.asked, { q: BUDGET_QUESTION, suggested: budgetSuggestion(answered.stakes) }] },
      };
    }
    return { step: { kind: "ask", index: answers.length }, state: answered };
  }

  const stakes = input.assessment?.stakes;
  const agentWork = input.agentWork === true;
  const fresh = (stage: OneModeState["stage"]): OneModeState => {
    const s: OneModeState = {
      stage,
      request: String(input.message || "").trim().slice(0, REQUEST_MAX),
      stakes,
      asked: [],
      answers: [],
    };
    if (agentWork) s.agentWork = true;
    const named = budgetInWords(input.message);
    if (named != null) s.budget = named;
    return s;
  };
  // Go now. Work for agents with no amount yet asks only how much to spend, first.
  const goFresh = (remember?: Remember): StepResult => {
    if (agentWork && input.canFollowUp && needsBudget(null, true, ctx)) return budgetFirst(fresh("budget"), remember);
    const budget = agentWork ? budgetFor(null, ctx) : null;
    const out: StepResult = {
      step: { kind: "go", how: "fresh", ...(agentWork ? { agentWork: true } : {}), ...(budget != null ? { budget } : {}) },
      state: null,
    };
    if (remember) out.remember = remember;
    return out;
  };
  if (goExplicit || delegates) {
    // "…, just do it" on a request the rule would have stopped for answers the choice
    // before it is asked ("…, surprise me" goes too, but is not remembered).
    return goFresh(goExplicit && input.fresh.ask ? keep(stakes, "go") : undefined);
  }
  if (!input.canFollowUp) return goFresh();
  if (wantsQuestionsFirst(input.message)) return { step: { kind: "ask", index: 0 }, state: fresh("asking"), remember: keep(stakes, "ask") };
  const what = askFirst(input.fresh, input.remembered, input.assessment);
  if (what === "offer") return { step: { kind: "offer" }, state: fresh("offered") };
  if (what === "questions") return { step: { kind: "ask", index: 0 }, state: fresh("asking") };
  return goFresh();
}

/** Kept in the conversation's memory under this key (never shown as a fact). */
export const STATE_KEY = "_one_mode";

/** The amount they set for this conversation's work, in dollars, so a follow-up to the
 *  same work is not asked again (hidden like STATE_KEY; the go turn states it). */
export const BUDGET_KEY = "_budget";

/** The kept amount, read back; null when none is set. */
export function readBudget(raw: string | null | undefined): number | null {
  const n = Number(String(raw ?? "").trim());
  return String(raw ?? "").trim() !== "" && Number.isFinite(n) && n >= 0 ? n : null;
}

export function encodeState(state: OneModeState): string {
  return JSON.stringify(state);
}

export function decodeState(raw: string | null | undefined): OneModeState | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<OneModeState>;
    if (s.stage !== "offered" && s.stage !== "asking" && s.stage !== "budget") return null;
    return {
      stage: s.stage,
      request: typeof s.request === "string" ? s.request : "",
      ...(s.stakes === "play" || s.stakes === "product" || s.stakes === "critical" ? { stakes: s.stakes } : {}),
      asked: Array.isArray(s.asked)
        ? s.asked
            .filter((x) => x && typeof x.q === "string")
            .map((x) => ({ q: String(x.q), suggested: typeof x.suggested === "string" ? x.suggested : "" }))
        : [],
      answers: Array.isArray(s.answers) ? s.answers.filter((x) => typeof x === "string") : [],
      ...(typeof s.carried === "number" && s.carried > 0 ? { carried: Math.min(9, Math.floor(s.carried)) } : {}),
      ...(s.agentWork === true ? { agentWork: true } : {}),
      ...(typeof s.budget === "number" && Number.isFinite(s.budget) && s.budget >= 0 ? { budget: s.budget } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Their remembered answers, one per stakes tier. Account-wide rows (no job), so a
 * choice made in one conversation spares them the question in the next; shown on
 * the Memory page in words ("Work for other people: just go, no questions first").
 */
export async function loadAskPreferences(sql: Sql, userId: string): Promise<Partial<Record<Stakes, AskPreference>>> {
  const rows = await sql.query<{ key: string; value: string }>(
    `SELECT key, value FROM buzzy_user_memory WHERE user_id = $1 AND job_id IS NULL AND key LIKE 'ask_first:%'`,
    [userId],
  );
  const out: Partial<Record<Stakes, AskPreference>> = {};
  for (const tier of ["play", "product", "critical"] as const) {
    const row = rows.find((r) => r.key === askPreferenceKey(tier));
    const pref = readAskPreference(row?.value);
    if (pref) out[tier] = pref;
  }
  return out;
}

/** Keep their answer for the tier. Delete-then-insert: a NULL job id never matches
 *  ON CONFLICT, so an upsert would add a row every time (same as profile.ts). */
export async function saveAskPreference(sql: Sql, userId: string, r: Remember): Promise<void> {
  const key = askPreferenceKey(r.stakes);
  await sql.query(`DELETE FROM buzzy_user_memory WHERE user_id = $1 AND job_id IS NULL AND key = $2`, [userId, key]);
  await sql.query(`INSERT INTO buzzy_user_memory (user_id, job_id, key, value) VALUES ($1, NULL, $2, $3)`, [
    userId,
    key,
    askPreferenceText(r.stakes, r.pref),
  ]);
}

/**
 * The question still waiting on them, to carry under a reply that did something else
 * meanwhile: its words for the reply, and its buttons.
 */
export function pendingPrompt(state: OneModeState): { line: string; options: ChoiceOption[]; kind: "offer" | "question" } {
  if (state.stage === "offered") {
    return { line: `Still open, whenever you're ready: ${OFFER_TEXT}`, options: OFFER_OPTIONS, kind: "offer" };
  }
  const last = state.asked[state.asked.length - 1];
  if (state.stage === "budget" || last?.q === BUDGET_QUESTION) {
    return { line: `Still open, whenever you're ready: ${BUDGET_QUESTION}`, options: budgetOptions(state.stakes), kind: "question" };
  }
  return {
    line: `Still open, whenever you're ready: ${last?.q ?? OPENING_QUESTIONS[0]}`,
    options: questionOptions(last?.suggested ?? ""),
    kind: "question",
  };
}

/** Their request as typed, for a line that points back to it ("…" when it is long). */
export function quoteTheirWords(request: string, max = 160): string {
  const t = String(request || "").trim().replace(/\s+/g, " ");
  return `“${t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t}”`;
}

/**
 * The ticket points back to their own words (owner, 2026-11-23: summaries point back
 * to what they typed, never replace it): "In your words: “…”" goes right under the
 * ticket's last line, or first when the reply has no ticket.
 */
export function withTheirWords(reply: string, request: string): string {
  const text = String(reply || "");
  if (!String(request || "").trim()) return text;
  const line = `In your words: ${quoteTheirWords(request, 300)}`;
  if (text.includes(line)) return text;
  const done = /(^|\n)[ \t]*(?:\*\*)?Done when(?:\*\*)?\s*:[^\n]*/i.exec(text);
  if (!done) return `${line}\n\n${text}`;
  const at = done.index + done[0].length;
  return text.slice(0, at) + "\n" + line + text.slice(at);
}

/** The reply for a question turn: the question, then BeeZilla's suggestion. */
export function questionText(q: string, suggested: string): string {
  return suggested ? `${q}\nSuggested: ${suggested}` : q;
}

/** The buttons under a question: the suggestion (one tap accepts it) and "Just go". */
export function questionOptions(suggested: string): ChoiceOption[] {
  const go = OFFER_OPTIONS[1]!;
  return suggested ? [{ label: suggested, send: suggested, value: "accept" }, go] : [go];
}

// ── 2. Prompts ──────────────────────────────────────────────────────────

/**
 * BeeZilla's one persona. The old Chat and Work personas are gone: no discovery
 * interview, no "does this plan look right?", no offer to "define the work". When a
 * turn asks first, the harness asks (the offer and the questions are written by this
 * file, not improvised by the model), so the persona can say: do the work.
 */
export const ONE_PERSONA = `You are BeeZilla. There is one way of working here: whatever the person brings — a quick question, an email to draft, a calculation, a picture, a business plan, a game they want built — you get it done, like a sharp, flexible colleague who wants them to succeed and respects their time.
- Answer what was actually asked in the first sentence, then stop. Two to five sentences unless they asked for a document, a list, or a step-by-step.
- No filler: no "great question", no "I'd be happy to help", no restating their message back at them, no emotional acknowledgement.
- DO IT, DON'T PLAN IT: never answer with a plan for them to approve, never ask "does this plan look right?", and never ask permission to start. Decide the details yourself with sensible choices and do the work; the note at the end of these instructions says when a turn is different.
- TECHNICAL CHOICES ARE YOURS: the people here are not programmers. Never ask them a technical question (the stack, a database, the architecture, hosting, interfaces, file formats); decide it yourself. Mention one only when it is consequential and hard to reverse, in plain words, with your recommendation.
- ONE-WAY DOORS NEED THEIR WORDS: never publish, launch, send, pay or delete on your own reading of what they would probably want. The first public launch of anything needs their OK in so many words; until then, get it ready and say what is waiting for that OK.
- THE RESULT, NOT THE MEANS: people often describe a means ("a hide-and-seek game set in Chongqing") when what matters is the result they want (a game their kids love). Aim at the result. Keep what they explicitly asked for; if a better way to the same result exists, use it or name it in one line, with the trade-off.
- DON'T REINVENT THE WHEEL: before building anything from scratch, think about what already exists — a product, a free tool, an open-source project, a template, a ready-made dataset or 3D world. If something would get them most of the way, say so plainly in one line, with the trade-off. For example: "A free, detailed 3D New York already exists if you'd rather start there; I built Chongqing as you asked."
- MAKING SOMETHING: when the request is to make a picture, a track, a video or a 3D model, the app makes it — do not interview them about style, size, format or mood first. It is made with sensible defaults from what they said, then describe it in one or two sentences.
- SHOW, DON'T CLAIM: after doing the work, show proof of it — what you made (the app attaches files and pictures), and what you checked and how (the page you read, the sum you worked, the test you ran). Never claim a check you did not do.
- If they want something actually accomplished (bids gathered, a refund chased, a contract prepared), look it up and draft it here; anything that goes out waits for their OK. Never describe what you could do later instead of doing the part that stays inside.
- Never write a price, penalty, date, or fact the person did not state, and never add a refund, a deadline, a discount, a penalty, an admission, or a legal position they did not state; do not soften one they did write. Leave a clearly marked blank instead.
- WEB: you can search the live web and read any public page. If the person asks "what's the current X", "look up Y", or gives you a link, that is your job — the tools exist. Never say you "can't browse", "can't search the web", "don't have internet access" or "can't check that online"; doing so is false. If a lookup genuinely fails, say the lookup failed, not that you lack the ability. Cite the page you actually read.
- FILES AND THE LIBRARY: every deliverable you produce is saved automatically as a versioned document in their Library, with Markdown, PDF and Word copies. Never say you "can't save files", have "no file-storage tool", or ask them to copy text out of the chat. A turn that produced no document has nothing to point at: never claim a file exists because the phrasing was requested.
- Only use details from THIS conversation.
You never mention models, tokens, or technical internals.`;

/** A go turn never comes back as a questionnaire (seen 2026-11-23: "Just go for it" →
 *  "I need a few details… Please provide: 1. Salon name 2. Services & prices…"). */
const NO_QUESTIONS =
  " Never ask them for a name, a price, an address or any other detail: put a clearly marked placeholder such as " +
  "[Your business name] and keep going.";

/**
 * A reply that asks for details instead of doing the work: "please provide…", "I need a
 * few details", or a list of questions. On a turn that was told to go, the harness asks
 * the model once more to do the work with placeholders.
 */
export function asksInsteadOfDoing(reply: string): boolean {
  const text = String(reply || "");
  if (
    /\b(please (provide|share|send|tell me|let me know)|could you (please )?(tell|share|provide|send|confirm|let me know)|can you (please )?(tell|share|provide|send|confirm)|i need (a few|some|more|the following|these|a bit more) (details|information|info|things)|before i (start|begin|build|can start)|to get started,? i('ll)? need)\b/i.test(text)
  ) {
    return true;
  }
  const questionLines = text.split("\n").filter((l) => /\?\s*(\*\*)?\s*$/.test(l.trim()));
  return questionLines.length >= 2;
}

/** What the harness says when a go turn came back asking instead of doing. */
export const DO_IT_NOW =
  "They told you to go ahead, so do not ask them anything. Do the work now, in full: wherever a detail is missing " +
  "(a name, a price, an address), put a clearly marked placeholder such as [Your business name] and keep going. " +
  'Then end with "What I assumed for you:" and the list of what you decided for them.';

/**
 * The go turn's note, repeated as the very last line of the instructions (a local
 * model left out the assumptions list when the note sat only in the middle of them).
 */
export function goReminder(spoken = false): string {
  return (
    "THIS TURN, ONCE MORE: do the work now, in full. No questions: where a detail is missing, put a clearly marked " +
    "placeholder such as [Your business name] and keep going. " +
    (spoken
      ? "End with one short sentence naming the main thing you assumed for them."
      : 'End with "What I assumed for you:" and a short list, one line each starting with "- ".')
  );
}

/** The heading BeeZilla ends a go turn with, and the parser below looks for. */
export const ASSUMPTIONS_HEADING = "What I assumed for you:";

const ASSUMPTION_RULE =
  ` End your reply with a short list under the heading "${ASSUMPTIONS_HEADING}" — the decisions you made on their ` +
  "behalf about what it does, how it looks and who it is for (a technical choice only when it is hard to reverse, in " +
  "plain words), one short line each starting with \"- \", at most five, so they can review and change any of them. " +
  "When you write a document, this list goes in your reply to them as well, after you have written it.";
const ASSUMPTION_RULE_IF_ANY =
  ASSUMPTION_RULE + " Leave the list out when you decided nothing for them (a plain answer, a fact, a calculation).";
const ASSUMPTION_RULE_SPOKEN =
  " If you decided anything on their behalf, end with one short sentence naming the main thing you assumed.";

/**
 * The go turn's line about money: the most they said to spend, or, for work handed to
 * agents, that nothing which costs money starts until they name an amount.
 */
export function budgetNote(o: { agentWork?: boolean; budget?: number | null } = {}): string {
  if (o.budget != null) {
    return (
      `\n\nTHE BUDGET: at most ${formatDollars(o.budget)}, the amount they gave. Keep everything this work costs under it. ` +
      "If it cannot all be done within that, do the most valuable part and say what is left; never go over it."
    );
  }
  if (o.agentWork) {
    return (
      "\n\nNO BUDGET YET: they have not said how much to spend, so nothing that costs money starts this turn (no project " +
      "handed to agents, no research at scale). Do what fits in this reply, then say in one line that the rest starts as " +
      "soon as they pick an amount."
    );
  }
  return "";
}

/**
 * The note appended to the persona for this turn. Only go turns reach the model:
 * the offer and the questions are written by the harness.
 */
export function turnNote(
  how: GoHow,
  opts: { spoken?: boolean; interview?: Interview; budget?: number | null; agentWork?: boolean } = {},
): string {
  const assume = opts.spoken ? ASSUMPTION_RULE_SPOKEN : how === "fresh" ? ASSUMPTION_RULE_IF_ANY : ASSUMPTION_RULE;
  const money = budgetNote(opts);
  const qa = opts.interview
    ? "\n\nTHE REQUEST, in their words as typed" +
      (opts.interview.qa.length ? ", AND THEIR ANSWERS (a suggestion they accepted counts as theirs)" : "") +
      `:\nRequest: ${opts.interview.request.slice(0, 4000)}` +
      (opts.interview.qa.length ? "\n" + opts.interview.qa.map((x) => `- ${x.q} → ${x.a.slice(0, 600)}`).join("\n") : "")
    : "";
  if (how === "skipped") {
    return (
      "\n\nTHIS TURN: they chose not to answer (more) questions — just go. Do what they asked earlier in this conversation now, " +
      "deciding every remaining detail yourself with the choices that best serve them. No questions, no plan to approve." +
      NO_QUESTIONS + assume + money + qa
    );
  }
  if (how === "budget") {
    return (
      "\n\nTHIS TURN: do what they asked earlier in this conversation now (the request below), deciding every remaining " +
      "detail yourself with the choices that best serve them. No more questions, no plan to approve." +
      NO_QUESTIONS + assume + money + qa
    );
  }
  if (how === "ticket") {
    return (
      "\n\nTHIS TURN: they answered your questions. Start with a short ticket in their words, one line each:\n" +
      "For: who it is for\n" +
      "Why: what they are really trying to achieve, the problem underneath\n" +
      "Their idea: what they first pictured, if they named something (a starting point, not a spec)\n" +
      "Outcome: the result they want\n" +
      "Limits: the hard limits they gave (time, money, what must never happen); leave this line out if they gave none\n" +
      "Done when: how they will know it worked\n" +
      "Then do the work toward that outcome straight away — no confirmation question. Aim at the why and the outcome, not " +
      "at their first idea of how: if a better way to reach it exists, take it and say why in one line." +
      NO_QUESTIONS + assume + money + qa
    );
  }
  return (
    "\n\nTHIS TURN: do what they asked now — no questions, no plan to approve. Where something is unstated, choose what serves them best." +
    NO_QUESTIONS + assume + money
  );
}

// ── 3. Reading the reply: assumptions and the ticket ───────────────────

/** The assumptions listed under the heading (or "Assumptions:"), in order. */
export function parseAssumptions(reply: string): string[] {
  const text = String(reply || "");
  const head = /(?:^|\n)\s*(?:\*\*)?(what i assumed( for you)?|assumptions( i made)?|i assumed)(?:\*\*)?\s*:?\s*(?:\*\*)?\s*\n/i.exec(text);
  if (!head) return [];
  const out: string[] = [];
  for (const line of text.slice(head.index + head[0].length).split("\n")) {
    const t = line.trim();
    if (!t) {
      if (out.length) break;
      continue;
    }
    const item = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(t);
    if (!item) break;
    out.push(item[1]!.replace(/\*\*/g, "").trim().slice(0, 200));
    if (out.length >= 8) break;
  }
  return out;
}

/** A ticket's lines: who it is for, the why, their idea (kept apart from the why: a
 *  starting point, not a spec), the outcome, the hard limits, done when. */
export interface Ticket {
  for?: string;
  why?: string;
  idea?: string;
  outcome?: string;
  limits?: string;
  doneWhen?: string;
}

/** The ticket's lines, when the reply starts with one. */
export function parseTicket(reply: string): Ticket {
  const text = String(reply || "");
  const line = (label: string) => {
    const m = new RegExp(`(?:^|\\n)\\s*(?:\\*\\*)?${label}(?:\\*\\*)?\\s*:\\s*(?:\\*\\*)?\\s*(.+)`, "i").exec(text);
    return m ? m[1]!.replace(/\*\*/g, "").trim().slice(0, 200) : undefined;
  };
  const out: Ticket = {};
  const f = line("For");
  const w = line("Why");
  const i = line("Their idea");
  const o = line("Outcome");
  const l = line("Limits");
  const d = line("Done when");
  if (f) out.for = f;
  if (w) out.why = w;
  if (i) out.idea = i;
  if (o) out.outcome = o;
  if (l) out.limits = l;
  if (d) out.doneWhen = d;
  return out;
}

// ── 4. The questions: the fewest that change the result ───────────────

type Complete = (
  messages: Array<{ role: string; content: string }>,
  opts: { model?: string; temperature?: number; maxTokens?: number },
) => Promise<string>;

/**
 * A technical question: the stack, a database, the architecture, hosting, interfaces
 * between systems. People here are not programmers (owner, 2026-11-23): BeeZilla asks
 * product questions only (what it should do, look like, who it is for, what the
 * business needs) and decides the technical ones itself. Narrow on purpose: "How many
 * tables do you want bookable online?" or "Should customers log in to see past
 * orders?" are product questions.
 */
const TECHNICAL =
  /\b(tech(nology|nical)?\s+stack|stack|frameworks?|databases?|sql|nosql|postgres(ql)?|mysql|mongo\w*|firebase|supabase|back-?ends?|front-?ends?|server-?side|serverless|web ?servers?|hosting|web ?host|host(ed)? (it|the (site|app|website))|cloud (provider|hosting|platform)|aws|azure|gcp|vercel|netlify|heroku|rest(ful)?|graphql|apis?|endpoints?|architecture|micro-?services?|monolith|schemas?|data ?models?|deploy(ment|ing)?|ci\/cd|docker|kubernetes|containers?|react|vue|angular|svelte|next\.?js|node\.?js|python|javascript|typescript|programming languages?|code ?base|sdks?|oauth|sso|authentication (method|provider)|webhooks?|caching|cdn|dns|repositor(y|ies)|git(hub)?|version control|npm|interfaces? between)\b/i;

export function isTechnicalQuestion(question: string): boolean {
  return TECHNICAL.test(String(question || ""));
}

/**
 * A question about the product itself: its features, what it should include, how it
 * should look or work. Owner, 2026-11-23 ("The new way forward"): start with the why,
 * and explain the guardrails, not the product. A guardrail limits what is allowed
 * (time, money, who it is for, what must never happen); a specification dictates how
 * to solve the problem, and that is BeeZilla's job. Their idea ("I think a racing game
 * might be the answer") is a starting point, so the questions ask what it is for,
 * never how it should work. Questions about their situation today ("Do you take online
 * orders today?") and the walls ("When do you need it by?") stay.
 */
const SPEC =
  /\b(features?|functionality|look like|look and feel|colou?rs?|colou?r scheme|themes?|layouts?|fonts?|animations?|game ?play|mechanics|characters?|what pages|which pages|how many (pages|levels|screens)|what levels|online (ordering|booking|payments?|checkout))\b|\bshould (it|the [\w ]{1,24}?|they|customers|users|players|people|visitors|guests) (have|include|show|display|offer|support|let|allow|be able to|use|work|look|play|feel|come with)\b|\bwhat should (it|the [\w ]{1,24}?) (say|include|have|show|contain|do)\b|\b(do|would) you (want|like|prefer|need) (it to\b|(a|an|the|some|any) [\w -]{0,30}?\b(pages?|sections?|features?|buttons?|forms?|logins?|galler(y|ies)|blogs?|shops?|carts?|menus?|chats?|maps?|calendars?|booking|search|filters?|levels?|modes?|characters?)\b|to (have|add|include|show)\b)|\b(want|like) (customers|users|people|players|visitors|guests|them) to\b|\bhow should (it|the [\w ]{1,24}?) (work|look|play|behave|feel)\b|\bwhat (kind|sort|type|style) of (design|look|layout|style|vibe|features?)\b/i;

export function isSpecQuestion(question: string): boolean {
  return SPEC.test(String(question || ""));
}

/** Parse the generator's JSON; null when there is no usable question. */
export function parseQuestion(raw: string, fixed?: string): { q: string; suggested: string } | null {
  const text = String(raw || "").replace(/```json|```/g, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return fixed ? { q: fixed, suggested: "" } : null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return fixed ? { q: fixed, suggested: "" } : null;
  }
  const clean = (v: unknown, max: number) =>
    typeof v === "string" ? v.replace(/\s+/g, " ").replace(/^["“]|["”]$/g, "").trim().slice(0, max) : "";
  let suggested = clean(obj.suggested, 160);
  if (/\?\s*$/.test(suggested) || /^(it depends|n\/a|none|null|unknown)\b/i.test(suggested)) suggested = "";
  if (fixed) return { q: fixed, suggested };
  let q = clean(obj.question, 200);
  if (!q || q.toLowerCase() === "null") return null;
  // Technical questions are BeeZilla's to decide, never the person's to answer; so are
  // the product's features and looks (ask the why and the walls, never the spec).
  if (isTechnicalQuestion(q) || isSpecQuestion(q)) return null;
  if (!/\?$/.test(q)) q += "?";
  return { q, suggested };
}

/**
 * Question `index` and BeeZilla's suggested answer.
 *
 * The first two questions are fixed; the model only suggests their answers. After
 * them it may ask one more at a time, only when the answer would change the result,
 * and returns null when nothing left would. A failed call never blocks: an opener is
 * asked without a suggestion, and a later question becomes "go".
 */
export async function interviewQuestion(opts: {
  index: number;
  request: string;
  /** Their words and BeeZilla's questions so far, oldest first. */
  transcript: string;
  /** What is already known: captured facts, company facts, the board. */
  known: string;
  asked: string[];
  complete: Complete;
  models: string[];
}): Promise<{ q: string; suggested: string } | null> {
  const fixed = opts.index < OPENING_QUESTIONS.length ? OPENING_QUESTIONS[opts.index] : undefined;
  const rules = fixed
    ? `The question is fixed: "${fixed}". Return it unchanged as "question" and write only the suggested answer.`
    : 'Choose the ONE question whose answer would most change the result, answerable in a few words. They are not ' +
      "programmers: ask a PRODUCT question only, about the why or the walls: what they are really trying to achieve, or a " +
      "hard limit that changes what is possible (time, money, who it is for, what must never happen). Never ask about " +
      "features, what it should include, how it should look or work, and never a technical one (stack, database, " +
      "architecture, hosting, interfaces, tools, formats, steps): BeeZilla decides those itself. A guardrail limits what is " +
      "allowed; a specification dictates how to solve the problem, and that part is BeeZilla's job. Their idea of what to " +
      'make ("a racing game") is a starting point, not a spec: ask what it is for, never how it should work. Never ask ' +
      "what the request, the conversation or the facts below already answer, and never repeat an earlier question (how much " +
      'to spend is asked separately). If no remaining question about the why or the walls would change the result, reply {"question": null}.';
  const system =
    "You prepare one quick question BeeZilla asks a person before it builds what they asked for; they chose to answer a few " +
    'questions first. Reply with ONLY a JSON object, no prose: {"question": "...", "suggested": "..."}. ' +
    rules +
    ' "suggested" is BeeZilla\'s best answer on their behalf, inferred from the request and everything known: in their own ' +
    "voice (\"I…\", \"We…\", \"My kids…\"), concrete, at most 18 words, so that one tap accepts it. Never a question, never " +
    '"it depends", never a price, date or fact they have not given.';
  const user =
    `Request: ${opts.request.slice(0, 800)}\n\n` +
    (opts.transcript ? `Conversation so far:\n${opts.transcript.slice(-2500)}\n\n` : "") +
    (opts.known ? `Already known:\n${opts.known.slice(0, 1500)}\n\n` : "") +
    (opts.asked.length ? `Already asked:\n${opts.asked.map((q) => "- " + q).join("\n")}` : "Nothing asked yet.");
  for (const model of opts.models) {
    try {
      const raw = await opts.complete(
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        { model, temperature: 0.2, maxTokens: 220 },
      );
      const parsed = parseQuestion(raw, fixed);
      if (parsed && fixed && !parsed.suggested) continue; // try the next model for a suggestion
      if (parsed && !fixed && opts.asked.some((q) => q.toLowerCase() === parsed.q.toLowerCase())) return null;
      return parsed;
    } catch {
      // Next model; a failed call degrades to fewer questions, never to a stuck turn.
    }
  }
  return fixed ? { q: fixed, suggested: "" } : null;
}
