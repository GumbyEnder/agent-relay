/**
 * Code Monkey's workshop — the server half.
 *
 * A coding project is an ordinary BeeZilla job (template "code") whose
 * `data.codeMonkey` links it to a Dev Boards board underneath. The person sees a
 * plain checklist of steps (Waiting / Working / Needs you / Checking / Done) and
 * the proof; the agents see missions they already know how to work (poll Ready →
 * claim → heartbeat → escalate one question → deliver with artifacts). See
 * docs/beezilla/CODE-MONKEY.md, which also records the owner's decisions of 2026-11-23.
 *
 * Lifecycle of one step:
 *   ready (or blocked until its "after" steps are done) → running → review
 *   → an independent review mission for a model from a DIFFERENT company
 *     (none possible = the step finishes "not independently reviewed", never "passed")
 *   → done when the policy allows it, or the owner's turn (critical work, and
 *     points of no return they haven't authorized).
 *   A one-way step never runs its irreversible part before the review: once the
 *   owner's go-ahead (or their own earlier words) authorizes it, it goes back to
 *   Ready once with "go ahead", and that delivery completes it.
 *
 * The owner's original words are kept as they were typed; the result card is a
 * summary that points back to them, never a replacement.
 *
 * Every state change here is idempotent: reading a project twice never
 * releases, reviews or accepts anything twice. Other steps keep moving while one
 * waits for the owner.
 *
 * Budget (owner, 2026-11-23, budget.ts): no project starts without an amount the owner
 * said themselves; each delivery's cost is counted once; once the budget is used up,
 * nothing new starts (no new step, review, redo or go-ahead) until the owner adds more.
 * Accepting finished work costs nothing and always goes through. Before anything is
 * built, the owner's earlier projects and BeeZilla's archive are searched (`lookFirst`)
 * and what fits is handed to the agents.
 */
import type { Sql } from "@/lib/db";
// The consumer product writes into the console only through this alias, like
// execution.ts, so scripts/check-buzzy-boundary.mjs can see it is deliberate.
import { boardOps } from "@/lib/board-server";
import {
  addToBudget,
  budgetView,
  countDelivery,
  effortFor,
  emptySpend,
  settleBudget,
  type Budget,
  type BudgetChoice,
  type BudgetSettled,
  type BudgetView,
  type Effort,
  type Spend,
} from "./budget";
import { searchInspiration } from "./inspirationSearch";
import {
  type Found,
  type ResultCard,
  type Slice,
  type SliceState,
  type Stakes,
  normalizeCard,
  normalizeSlices,
  settleSlices,
  settleStakes,
  validateCard,
  validateSlices,
  topoOrder,
  missionBrief,
  reviewPolicy,
  stateFromColumn,
  slicesToRelease,
  authorizedByWords,
  providerOf,
  reviewIsIndependent,
  PROOF_WORDS,
} from "./codeMonkey";

export interface LinkedSlice extends Slice {
  missionId: string;
  /** The independent review mission, once one exists. */
  reviewMissionId?: string;
  /** Result of the latest independent review, kept so the owner sees it after the review mission is done. */
  reviewed?: "pass" | "not-available";
  /** The sentence of the owner's own words that authorized this one-way step, if any. */
  authorizedBy?: string;
  /** The owner (or their standing launch policy) said go: its next delivery completes it. */
  goAhead?: boolean;
}

export interface LaunchPolicy {
  /** May this project go public without asking again? */
  authorized: boolean;
  /** Where the authorization came from, in words the owner recognises. */
  source: "your words" | "your go-ahead";
  /** The owner's own sentence, or the step they approved. */
  evidence: string;
  scope: "this project";
  at: string;
}

export interface CodeMonkeyLink {
  projectId: string;
  agentName: string;
  reviewerName: string;
  builderProvider: string | null;
  reviewerProvider: string | null;
  /** False when no reviewer from a different company is set up — reviews are then reported as not done. */
  reviewIndependent: boolean;
  card: ResultCard;
  stakesRaisedFrom?: Stakes;
  /** The owner's original request, exactly as typed. Never summarised over. */
  source: { words: string; at: string };
  launch?: LaunchPolicy;
  /** Set from the owner's own words before anything started (absent on projects from before 2026-11-23's rule). */
  budget?: Budget;
  /** What has been spent so far, each delivery counted once. */
  spend?: Spend;
  /** What the budget buys: searches, areas, versions. */
  effort?: Effort;
  /** What was already on BeeZilla when the project started, handed to the agents. */
  found?: Found[];
  slices: LinkedSlice[];
  createdAt: string;
}

export interface SliceView {
  key: string;
  title: string;
  shows: string;
  doneWhen: string[];
  after: string[];
  door: Slice["door"];
  doorWhy: string;
  state: SliceState;
  /** What the person would be asked, if anything. */
  question?: { callId: string; text: string };
  /** The owner's turn to look (critical work, or a point of no return they haven't authorized). */
  ownerLooks: boolean;
  /** The owner's own words that already authorize this step's point of no return. */
  authorizedBy?: string;
  /** Proof the worker attached (links, screenshot URLs) and its summary. */
  proof: { summary: string; links: string[] };
  review?: { state: SliceState; summary: string };
  /** "pass" = reviewed by another company and passed; "not-available" = no independent reviewer; null = not yet. */
  reviewed: "pass" | "not-available" | null;
  progress: string;
  proofWanted: string[];
}

export interface CodeProjectView {
  jobId: string;
  card: ResultCard;
  stakesRaisedFrom?: Stakes;
  source: { words: string; at: string };
  reviewIndependent: boolean;
  builderProvider: string | null;
  reviewerProvider: string | null;
  launch?: LaunchPolicy;
  /** The budget and what's used; null on projects from before budgets. */
  budget: BudgetView | null;
  effort?: Effort;
  found: Found[];
  /** New work is waiting for the owner to add to the budget. */
  heldForBudget: boolean;
  slices: SliceView[];
  counts: Record<SliceState, number>;
}

const HARNESS = () => (process.env.BZ_CODE_HARNESS || "claude_code").trim();
/** A different company reviews than builds — that is what makes the review independent. */
const REVIEW_HARNESS = () => (process.env.BZ_CODE_REVIEW_HARNESS || "codex").trim();

function shortId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function parseData(v: unknown): Record<string, unknown> {
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return {};
    }
  }
  return (v as Record<string, unknown>) ?? {};
}

type StartInput = {
  card: unknown;
  slices: unknown;
  /** Everything the owner typed for this request, oldest first, exactly as typed. */
  words?: string;
  /** The budget the model read from the owner, in dollars. Checked against their words. */
  budgetDollars?: unknown;
  /** The owner's reply to the budget question, when this turn is one. */
  budgetAnswer?: string;
  companyId?: string | null;
};
export type StartResult =
  | { ok: true; jobId: string; project: CodeProjectView }
  | { ok: false; code: "invalid"; problems: string[] }
  | { ok: false; code: "needs-budget"; stakes: Stakes; reason: Exclude<BudgetSettled, { ok: true }>["reason"]; choices: BudgetChoice[] };

const STOP_WORDS = new Set(
  "the and for with that this from your you our their them they make made want build game app apps site website page tool something simple little new"
    .split(" "),
);
function keyWords(text: string): string[] {
  return [...new Set(String(text || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w)))];
}

/**
 * Look on BeeZilla first (owner, 2026-11-23): the owner's own earlier coding projects,
 * then BeeZilla's archive (starting boards, their recipes, documents and Library). Only
 * the owner's own work and BeeZilla's public starting boards are searched: other
 * people's private projects never are. Free: nothing here reaches the internet.
 */
export async function lookFirst(sql: Sql, userId: string, card: Pick<ResultCard, "making" | "why" | "forWhom">): Promise<Found[]> {
  const found: Found[] = [];
  const want = keyWords(`${card.making} ${card.why} ${card.forWhom}`);
  try {
    const rows = await sql<{ id: string; title: string | null; data: unknown }>`
      SELECT id, title, data FROM buzzy_jobs
      WHERE user_id = ${userId} AND template = 'code'
      ORDER BY updated_at DESC LIMIT 50
    `;
    const scored = rows
      .map((r) => {
        const link = parseData(r.data).codeMonkey as CodeMonkeyLink | undefined;
        const have = keyWords(`${r.title ?? ""} ${link?.card?.making ?? ""} ${link?.card?.why ?? ""}`);
        const shared = want.filter((w) => have.includes(w)).length;
        return { r, link, shared };
      })
      .filter((x) => x.link && x.shared >= Math.min(2, want.length))
      .sort((a, b) => b.shared - a.shared)
      .slice(0, 2);
    for (const { r, link } of scored) {
      const links: string[] = [];
      for (const s of link!.slices ?? []) {
        const m = await mission(s.missionId);
        if (m && (m.column === "done" || m.column === "review")) links.push(...(m.artifacts ?? []), ...linksIn(m.delivery ?? ""));
        if (links.length >= 6) break;
      }
      found.push({
        source: "Your earlier project",
        title: String(r.title || link!.card?.making || "an earlier project").slice(0, 120),
        about: link!.card?.why ? `made so that ${link!.card.why}`.slice(0, 200) : `Code Monkey project ${r.id}`,
        links: [...new Set(links)].slice(0, 6),
      });
    }
  } catch {
    /* no jobs table yet: the archive below still answers */
  }
  try {
    const hits = await searchInspiration(sql, userId, card.making);
    for (const h of hits.slice(0, 4)) found.push({ source: h.source, title: h.title, about: h.about });
  } catch {
    /* the archive is a bonus */
  }
  return found.slice(0, 6);
}

/** Validate the card and steps, then create the job, the board, the agents and the missions. */
export async function startCodeProject(sql: Sql, userId: string, input: StartInput): Promise<StartResult> {
  const card = normalizeCard((input.card ?? {}) as Record<string, unknown>);
  const ownerWords = String(input.words ?? "").slice(0, 8000);
  const words = [ownerWords, card.making, card.why, card.forWhom, card.outcome, ...card.doneWhen.map((c) => c.text)].filter(Boolean).join("\n");
  const settled = settleStakes(card.stakes, words);
  const stakesRaisedFrom = settled.raised ? card.stakes : undefined;
  if (settled.raised) {
    card.stakes = settled.stakes;
    card.stakesWhy = settled.why.join("; ");
  }
  const sliceInputs = normalizeSlices(input.slices);
  const problems = [...validateCard(card), ...validateSlices(sliceInputs)];
  if (problems.length) return { ok: false, code: "invalid", problems };
  // Budget before going: only an amount the owner said themselves (budget.ts).
  const settledBudget = settleBudget({ words: ownerWords, answer: input.budgetAnswer, modelDollars: input.budgetDollars, stakes: card.stakes });
  if (!settledBudget.ok) {
    return { ok: false, code: "needs-budget", stakes: card.stakes, reason: settledBudget.reason, choices: settledBudget.choices };
  }
  const budget = settledBudget.budget;
  const effort = effortFor(budget.cents);
  const slices = settleSlices(sliceInputs);
  const found = await lookFirst(sql, userId, card);

  const builderProvider = providerOf(HARNESS(), process.env.BZ_CODE_PROVIDER);
  const reviewerProvider = providerOf(REVIEW_HARNESS(), process.env.BZ_CODE_REVIEW_PROVIDER);
  const now = new Date().toISOString();
  // Only the owner's own words can authorize a point of no return — never the card the model wrote.
  const authorizedFor = (s: Slice) => (s.door === "one-way" ? authorizedByWords(ownerWords, s.doorKind) : null);
  const publishWords = slices.map((s) => (s.doorKind === "publish" ? authorizedFor(s) : null)).find(Boolean) ?? null;

  const jobId = `job_${shortId()}`;
  const suffix = jobId.slice(-8);
  const project = await boardOps.createProject({
    name: `Code Monkey: ${card.making}`.slice(0, 80),
    description: `Shop floor for BeeZilla coding project ${jobId}. Stakes: ${card.stakes}.`,
    ownerUserId: userId,
  });
  const agentName = `code-monkey-${suffix}`;
  const reviewerName = `code-review-${suffix}`;
  await boardOps.registerAgent({ name: agentName, harness: HARNESS() as never, role: "builder", skills: ["code"], projectId: project.id });
  await boardOps.registerAgent({ name: reviewerName, harness: REVIEW_HARNESS() as never, role: "reviewer", skills: ["code-review"], projectId: project.id });

  const linked: LinkedSlice[] = [];
  for (const key of topoOrder(slices) ?? slices.map((s) => s.key)) {
    const slice = slices.find((s) => s.key === key)!;
    const authorizedBy = authorizedFor(slice);
    const brief = missionBrief(card, slice, slices, authorizedBy, { budget, effort, found });
    const made = await boardOps.createMission({
      ...brief,
      priority: "p2",
      column: slice.after.length ? "blocked" : "ready",
      projectId: project.id,
      createdByAgentName: "code-monkey",
    });
    const missionId = made.ok ? made.data.mission.id : "";
    linked.push(authorizedBy ? { ...slice, missionId, authorizedBy } : { ...slice, missionId });
  }

  const link: CodeMonkeyLink = {
    projectId: project.id,
    agentName,
    reviewerName,
    builderProvider,
    reviewerProvider,
    reviewIndependent: reviewIsIndependent(builderProvider, reviewerProvider),
    card,
    stakesRaisedFrom,
    source: { words: ownerWords, at: now },
    launch: publishWords ? { authorized: true, source: "your words", evidence: publishWords, scope: "this project", at: now } : undefined,
    budget,
    spend: emptySpend(),
    effort,
    found,
    slices: linked,
    createdAt: now,
  };
  await sql`
    INSERT INTO buzzy_jobs (id, user_id, template, title, status, company_id, data, updated_at)
    VALUES (${jobId}, ${userId}, 'code', ${card.making.slice(0, 120)}, 'working', ${input.companyId ?? null},
            ${JSON.stringify({ codeMonkey: link })}::jsonb, now())
  `;
  const view = await readCodeProject(sql, userId, jobId);
  return { ok: true, jobId, project: view! };
}

async function loadLink(sql: Sql, userId: string, jobId: string): Promise<CodeMonkeyLink | null> {
  const rows = await sql<{ data: unknown }>`
    SELECT data FROM buzzy_jobs WHERE id = ${jobId} AND user_id = ${userId} AND template = 'code' LIMIT 1
  `;
  if (!rows.length) return null;
  const link = parseData(rows[0].data).codeMonkey as CodeMonkeyLink | undefined;
  return link?.projectId ? link : null;
}

async function saveLink(sql: Sql, userId: string, jobId: string, link: CodeMonkeyLink, status?: string): Promise<void> {
  await sql`
    UPDATE buzzy_jobs
    SET data = COALESCE(data, '{}'::jsonb) || ${JSON.stringify({ codeMonkey: link })}::jsonb,
        status = COALESCE(${status ?? null}, status),
        updated_at = now()
    WHERE id = ${jobId} AND user_id = ${userId}
  `;
}

type MissionRow = {
  id: string;
  column: string;
  delivery?: string;
  artifacts?: string[];
  progressNote?: string;
  usage?: { tokensIn?: number; tokensOut?: number; estimatedUsd?: number } | null;
};

async function mission(id: string | undefined): Promise<MissionRow | null> {
  if (!id) return null;
  const m = (await boardOps.getMission(id)) as MissionRow | null;
  return m ?? null;
}

function linksIn(text: string): string[] {
  return [...String(text || "").matchAll(/https?:\/\/[^\s)<>"']+/g)].map((m) => m[0]).slice(0, 12);
}

async function reviewVerdict(reviewMissionId: string | undefined): Promise<"pass" | "fail" | "pending"> {
  const r = await mission(reviewMissionId);
  if (!r || (r.column !== "done" && r.column !== "review")) return "pending";
  const text = String(r.delivery ?? "");
  if (/\bVERDICT\s+FAIL\b/i.test(text) || /^\s*-?\s*FAIL\b/im.test(text)) return "fail";
  if (/\bVERDICT\s+PASS\b/i.test(text)) return "pass";
  return "pending";
}

/** Is this one-way step's point of no return already authorized — by the owner's words or the project's launch policy? */
function authorizedNow(link: CodeMonkeyLink, s: LinkedSlice): boolean {
  if (s.door !== "one-way") return false;
  if (s.authorizedBy) return true;
  return s.doorKind === "publish" && link.launch?.authorized === true;
}

async function goAhead(s: LinkedSlice, note: string): Promise<boolean> {
  s.goAhead = true;
  await boardOps.comment(s.missionId, "code-monkey", note);
  const back = await boardOps.moveMission(s.missionId, "ready", "code-monkey", "system");
  return back.ok;
}

/**
 * Read a project, and move it along where the rules say it may move on its own:
 * release steps whose "after" steps are done, open independent reviews for
 * delivered work, accept what the policy lets through, and send authorized
 * points of no return back for their final step.
 */
export async function readCodeProject(sql: Sql, userId: string, jobId: string): Promise<CodeProjectView | null> {
  const link = await loadLink(sql, userId, jobId);
  if (!link) return null;
  let changed = false;

  const rows = new Map<string, MissionRow | null>();
  for (const s of link.slices) rows.set(s.key, await mission(s.missionId));
  const columnOf = Object.fromEntries(link.slices.map((s) => [s.key, rows.get(s.key)?.column ?? "inbox"]));

  // 0. Count what finished work cost, each delivery once (builders' and reviewers'), and
  //    decide whether new work may start. Projects from before budgets have no ceiling.
  const spend = link.spend ?? emptySpend();
  for (const s of link.slices) {
    const m = rows.get(s.key);
    if (m && (m.column === "review" || m.column === "done") && countDelivery(spend, m.id, m.delivery, m.usage)) changed = true;
    const r = s.reviewMissionId ? await mission(s.reviewMissionId) : null;
    if (r && (r.column === "review" || r.column === "done") && countDelivery(spend, r.id, r.delivery, r.usage)) changed = true;
  }
  link.spend = spend;
  const budgetNow = budgetView(link.budget, spend);
  // "ask" (close to the ceiling) and "refuse" (at it) both wait for the owner's tap.
  const mayStartWork = !budgetNow || budgetNow.verdict === "allow";
  let heldForBudget = false;

  // 1. Delivered work: review, accept, send back, or hand to the owner.
  for (const s of link.slices) {
    if (columnOf[s.key] !== "review") continue;
    const policy = reviewPolicy(link.card.stakes, s.door);
    const m = rows.get(s.key);
    const proofLinks = [...(m?.artifacts ?? []), ...linksIn(m?.delivery ?? "")];

    if (s.goAhead) {
      // The point of no return was authorized after its review; this delivery finishes it.
      const done = await boardOps.moveMission(s.missionId, "done", "code-monkey", "system");
      if (done.ok) columnOf[s.key] = "done";
      continue;
    }

    // Every step is reviewed by another company's model — when one is set up.
    if (link.reviewIndependent) {
      if (!s.reviewMissionId) {
        if (!mayStartWork) {
          heldForBudget = true;
          continue;
        }
        const made = await boardOps.createMission({
          title: `Review: ${s.title}`.slice(0, 120),
          objective: `Check, with a fresh pair of eyes, that "${s.title}" really does what its done checks say. You did not build it, and you are from a different company than the model that did.`,
          context: `Project: ${link.card.making} — for ${link.card.forWhom}. Stakes: ${link.card.stakes}.\nWhat the builder delivered:\n${(m?.delivery ?? "").slice(0, 3000)}\nProof attached:\n${proofLinks.map((l) => `- ${l}`).join("\n") || "- none"}`,
          constraints: "Do not fix anything yourself: report. Run the tests, then run the real app and try each check the way the owner would. Judge the evidence, not the builder's claims. Be strict: don't soften a FAIL because the builder disagrees, and don't invent problems you can't show.",
          acceptance: [
            "Deliver one line per done check, each starting with PASS or FAIL and the evidence you saw yourself:",
            ...s.doneWhen.map((c) => `- ${c.text}`),
            "Then one line: VERDICT PASS or VERDICT FAIL.",
          ].join("\n"),
          tags: ["code-monkey", "review", `review-of:${s.key}`],
          priority: "p1",
          column: "ready",
          projectId: link.projectId,
          createdByAgentName: "code-monkey",
        });
        if (made.ok) {
          s.reviewMissionId = made.data.mission.id;
          changed = true;
        }
        continue;
      }
      const verdict = await reviewVerdict(s.reviewMissionId);
      if (verdict === "pending") continue;
      if (verdict === "fail") {
        // A redo costs money: it waits while the budget is used up.
        if (!mayStartWork) {
          heldForBudget = true;
          continue;
        }
        // Back to the builder with the reviewer's findings; a fresh review follows the next delivery.
        const r = await mission(s.reviewMissionId);
        await boardOps.comment(s.missionId, "code-monkey", `Independent review found problems:\n${(r?.delivery ?? "").slice(0, 2000)}`);
        const back = await boardOps.moveMission(s.missionId, "ready", "code-monkey", "system");
        if (back.ok) columnOf[s.key] = "ready";
        s.reviewMissionId = undefined;
        s.reviewed = undefined;
        changed = true;
        continue;
      }
      if (s.reviewed !== "pass") {
        s.reviewed = "pass";
        changed = true;
      }
    } else if (s.reviewed !== "not-available") {
      // Recorded as not done — never as passed (owner's decision, 2026-11-23).
      s.reviewed = "not-available";
      changed = true;
    }

    if (s.door === "one-way" && authorizedNow(link, s)) {
      if (!mayStartWork) {
        heldForBudget = true;
        continue;
      }
      const why = s.authorizedBy ? `the owner asked for it: "${s.authorizedBy}"` : `the project's launch policy (${link.launch?.source}: ${link.launch?.evidence})`;
      if (await goAhead(s, `Reviewed. Go ahead with the irreversible step — ${why}. Then deliver with proof of what happened.`)) columnOf[s.key] = "ready";
      changed = true;
      continue;
    }
    if (policy.autoAccept) {
      if (proofLinks.length > 0) {
        const done = await boardOps.moveMission(s.missionId, "done", "code-monkey", "system");
        if (done.ok) columnOf[s.key] = "done";
      } else if (!mayStartWork) {
        heldForBudget = true;
      } else {
        // "Done" needs evidence the owner can look at, not a claim (owner's decision, 2026-11-23).
        await boardOps.comment(s.missionId, "code-monkey", `Delivered without proof. Attach ${policy.proof.map((p) => PROOF_WORDS[p]).slice(0, 3).join("; ")}.`);
        const back = await boardOps.moveMission(s.missionId, "ready", "code-monkey", "system");
        if (back.ok) columnOf[s.key] = "ready";
        s.reviewMissionId = undefined;
        s.reviewed = undefined;
        changed = true;
      }
    }
  }

  // 2. Release steps whose prerequisites are done — including any finished just above,
  //    so the next step starts in the same read instead of one poll later. Not while
  //    the budget is used up: those steps wait for the owner to add more.
  for (const key of slicesToRelease(link.slices, columnOf)) {
    if (!mayStartWork) {
      heldForBudget = true;
      break;
    }
    const s = link.slices.find((x) => x.key === key)!;
    const moved = await boardOps.moveMission(s.missionId, "ready", "code-monkey", "system");
    if (moved.ok) {
      columnOf[key] = "ready";
      rows.set(key, { ...(rows.get(key) as MissionRow), column: "ready" });
    }
  }

  // 3. Questions the workers escalated.
  const board = await boardOps.snapshot(link.projectId);
  const openCalls = (board?.calls ?? []).filter((c) => !c.resolvedAt);

  const views: SliceView[] = [];
  for (const s of link.slices) {
    const m = rows.get(s.key);
    const column = columnOf[s.key];
    const policy = reviewPolicy(link.card.stakes, s.door);
    const call = openCalls.find((c) => c.missionId === s.missionId);
    const review = s.reviewMissionId ? await mission(s.reviewMissionId) : null;
    let state = stateFromColumn(column);
    const reviewSettled = s.reviewed === "pass" || s.reviewed === "not-available";
    const ownerTurn = column === "review" && !s.goAhead && policy.ownerLooks && reviewSettled && !authorizedNow(link, s);
    if (call || ownerTurn) state = "needs-you";
    views.push({
      key: s.key,
      title: s.title,
      shows: s.shows,
      doneWhen: s.doneWhen.map((c) => c.text),
      after: s.after,
      door: s.door,
      doorWhy: s.doorWhy,
      state,
      question: call ? { callId: call.id, text: call.question } : undefined,
      ownerLooks: ownerTurn,
      authorizedBy: s.authorizedBy,
      proof: { summary: (m?.delivery ?? "").slice(0, 1200), links: [...(m?.artifacts ?? []), ...linksIn(m?.delivery ?? "")] },
      review: review ? { state: stateFromColumn(review.column), summary: (review.delivery ?? "").slice(0, 1200) } : undefined,
      reviewed: s.reviewed ?? null,
      progress: (m?.progressNote ?? "").slice(0, 300),
      proofWanted: policy.proof.map((p) => PROOF_WORDS[p]),
    });
  }

  const counts = { waiting: 0, working: 0, "needs-you": 0, checking: 0, done: 0 } as Record<SliceState, number>;
  for (const v of views) counts[v.state] += 1;
  const allDone = views.length > 0 && counts.done === views.length;
  if (changed || allDone) await saveLink(sql, userId, jobId, link, allDone ? "done" : undefined);

  return {
    jobId,
    card: link.card,
    stakesRaisedFrom: link.stakesRaisedFrom,
    source: link.source ?? { words: "", at: link.createdAt },
    reviewIndependent: link.reviewIndependent === true,
    builderProvider: link.builderProvider ?? null,
    reviewerProvider: link.reviewerProvider ?? null,
    launch: link.launch,
    budget: budgetNow,
    effort: link.effort,
    found: link.found ?? [],
    heldForBudget,
    slices: views,
    counts,
  };
}

export type OwnerAction =
  | { kind: "answer"; callId: string; text: string }
  | { kind: "looks-right"; sliceKey: string }
  | { kind: "not-yet"; sliceKey: string; text: string }
  | { kind: "add-budget"; dollars: number };

/** The things a person can do in the workshop. Everything else moves on its own. */
export async function ownerActs(sql: Sql, userId: string, jobId: string, action: OwnerAction, ownerName = "owner"): Promise<{ ok: boolean; error?: string }> {
  const link = await loadLink(sql, userId, jobId);
  if (!link) return { ok: false, error: "not_found" };
  if (action.kind === "add-budget") {
    // Only the owner raises the ceiling, one tap at a time; nothing else can.
    if (!link.budget) return { ok: false, error: "no_budget" };
    if (!addToBudget(link.budget, Math.round(Number(action.dollars) * 100))) return { ok: false, error: "bad_amount" };
    await saveLink(sql, userId, jobId, link);
    return { ok: true };
  }
  if (action.kind === "answer") {
    const text = String(action.text || "").trim().slice(0, 2000);
    if (!text) return { ok: false, error: "empty_answer" };
    const board = await boardOps.snapshot(link.projectId);
    const call = (board?.calls ?? []).find((c) => c.id === action.callId);
    if (!call || !link.slices.some((s) => s.missionId === call.missionId)) return { ok: false, error: "not_found" };
    const r = await boardOps.reply(action.callId, text, ownerName);
    return { ok: r.ok };
  }
  const s = link.slices.find((x) => x.key === action.sliceKey);
  if (!s) return { ok: false, error: "not_found" };
  const m = await mission(s.missionId);
  if (!m || m.column !== "review") return { ok: false, error: "not_waiting_for_you" };
  // A go-ahead or a redo starts paid work: not past the owner's own ceiling. (Accepting
  // finished work is free and always allowed.)
  const startsWork = action.kind === "not-yet" || s.door === "one-way";
  const ceiling = budgetView(link.budget, link.spend);
  if (startsWork && ceiling && ceiling.verdict !== "allow") return { ok: false, error: "budget_used_up" };
  if (action.kind === "looks-right") {
    if (s.door === "one-way") {
      // Approving a one-way step is the go-ahead for the part it held back. Approving
      // a launch also sets this project's launch policy for later releases.
      if (s.doorKind === "publish" && !link.launch?.authorized) {
        link.launch = { authorized: true, source: "your go-ahead", evidence: s.title, scope: "this project", at: new Date().toISOString() };
      }
      const ok = await goAhead(s, "The owner said go ahead: run the irreversible step now, then deliver with proof.");
      await saveLink(sql, userId, jobId, link);
      return { ok };
    }
    const done = await boardOps.moveMission(s.missionId, "done", ownerName, "human");
    return { ok: done.ok };
  }
  const text = String(action.text || "").trim().slice(0, 2000);
  if (!text) return { ok: false, error: "say_what_is_wrong" };
  await boardOps.comment(s.missionId, "code-monkey", `The owner looked and said: ${text}`);
  s.reviewMissionId = undefined;
  s.reviewed = undefined;
  await saveLink(sql, userId, jobId, link);
  const back = await boardOps.moveMission(s.missionId, "ready", "code-monkey", "system");
  return { ok: back.ok };
}

/** The person's coding projects, newest first, for the workshop's list. */
export async function listCodeProjects(sql: Sql, userId: string): Promise<{ jobId: string; making: string; status: string; updatedAt: string }[]> {
  const rows = await sql<{ id: string; title: string | null; status: string | null; updated_at: string }>`
    SELECT id, title, status, updated_at FROM buzzy_jobs
    WHERE user_id = ${userId} AND template = 'code'
    ORDER BY updated_at DESC LIMIT 50
  `;
  return rows.map((r) => ({ jobId: r.id, making: r.title ?? "", status: r.status ?? "working", updatedAt: String(r.updated_at) }));
}
