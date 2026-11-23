/**
 * Code Monkey's workshop — the server half.
 *
 * A coding project is an ordinary BeeZilla job (template "code") whose
 * `data.codeMonkey` links it to a Dev Boards board underneath. The person only
 * ever sees Waiting / Working / Needs you / Checking / Done and the proof; the
 * agents see missions they already know how to work (poll Ready → claim →
 * heartbeat → escalate one question → deliver with artifacts). See
 * docs/beezilla/CODE-MONKEY.md.
 *
 * Lifecycle of one slice:
 *   ready (or blocked until its "after" slices are done) → running → review
 *   → [independent review mission, for product/critical/one-way work]
 *   → done automatically when the policy allows it, or "needs you" when the
 *     owner looks (one-way doors and critical work). A one-way slice the owner
 *     approves goes back to Ready once, with "go ahead", so the worker runs the
 *     irreversible step it deliberately held back.
 *
 * Every state change here is idempotent: reading a project twice never
 * releases, reviews or accepts anything twice.
 */
import type { Sql } from "@/lib/db";
// The consumer product writes into the console only through this alias, like
// execution.ts, so scripts/check-buzzy-boundary.mjs can see it is deliberate.
import { boardOps } from "@/lib/board-server";
import {
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
  PROOF_WORDS,
} from "./codeMonkey";

export interface LinkedSlice extends Slice {
  missionId: string;
  /** The independent review mission, once one exists. */
  reviewMissionId?: string;
  /** One-way slice the owner said "go ahead" to: its next delivery completes it. */
  goAhead?: boolean;
}

export interface CodeMonkeyLink {
  projectId: string;
  agentName: string;
  reviewerName: string;
  card: ResultCard;
  stakesRaisedFrom?: Stakes;
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
  /** The owner's turn to look (one-way or critical work, after review). */
  ownerLooks: boolean;
  /** Proof the worker attached (links, screenshot URLs) and its summary. */
  proof: { summary: string; links: string[] };
  review?: { state: SliceState; summary: string };
  progress: string;
  proofWanted: string[];
}

export interface CodeProjectView {
  jobId: string;
  card: ResultCard;
  stakesRaisedFrom?: Stakes;
  slices: SliceView[];
  counts: Record<SliceState, number>;
}

const HARNESS = () => (process.env.BZ_CODE_HARNESS || "claude_code").trim();
/** A different provider reviews than builds — that is what makes the review independent. */
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

type StartInput = { card: unknown; slices: unknown; words?: string; companyId?: string | null };
export type StartResult =
  | { ok: true; jobId: string; project: CodeProjectView }
  | { ok: false; code: "invalid"; problems: string[] };

/** Validate the card and slices, then create the job, the board, the agents and the missions. */
export async function startCodeProject(sql: Sql, userId: string, input: StartInput): Promise<StartResult> {
  const card = normalizeCard((input.card ?? {}) as Record<string, unknown>);
  const words = [input.words, card.making, card.forWhom, card.outcome, ...card.doneWhen.map((c) => c.text)].filter(Boolean).join("\n");
  const settled = settleStakes(card.stakes, words);
  const stakesRaisedFrom = settled.raised ? card.stakes : undefined;
  if (settled.raised) {
    card.stakes = settled.stakes;
    card.stakesWhy = settled.why.join("; ");
  }
  const sliceInputs = normalizeSlices(input.slices);
  const problems = [...validateCard(card), ...validateSlices(sliceInputs)];
  if (problems.length) return { ok: false, code: "invalid", problems };
  const slices = settleSlices(sliceInputs);

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
    const brief = missionBrief(card, slice, slices);
    const made = await boardOps.createMission({
      ...brief,
      priority: "p2",
      column: slice.after.length ? "blocked" : "ready",
      projectId: project.id,
      createdByAgentName: "code-monkey",
    });
    const missionId = made.ok ? made.data.mission.id : "";
    linked.push({ ...slice, missionId });
  }

  const link: CodeMonkeyLink = {
    projectId: project.id,
    agentName,
    reviewerName,
    card,
    stakesRaisedFrom,
    slices: linked,
    createdAt: new Date().toISOString(),
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

type MissionRow = { id: string; column: string; delivery?: string; artifacts?: string[]; progressNote?: string };

async function mission(id: string | undefined): Promise<MissionRow | null> {
  if (!id) return null;
  const m = (await boardOps.getMission(id)) as MissionRow | null;
  return m ?? null;
}

function linksIn(text: string): string[] {
  return [...String(text || "").matchAll(/https?:\/\/[^\s)<>"']+/g)].map((m) => m[0]).slice(0, 12);
}

/**
 * Read a project, and move it along where the rules say it may move on its own:
 * release slices whose "after" slices are done, open independent reviews for
 * delivered work that needs one, and accept work the policy lets through.
 */
export async function readCodeProject(sql: Sql, userId: string, jobId: string): Promise<CodeProjectView | null> {
  const link = await loadLink(sql, userId, jobId);
  if (!link) return null;
  let changed = false;

  const rows = new Map<string, MissionRow | null>();
  for (const s of link.slices) rows.set(s.key, await mission(s.missionId));
  const columnOf = Object.fromEntries(link.slices.map((s) => [s.key, rows.get(s.key)?.column ?? "inbox"]));

  // 1. Release slices whose prerequisites are done.
  for (const key of slicesToRelease(link.slices, columnOf)) {
    const s = link.slices.find((x) => x.key === key)!;
    const moved = await boardOps.moveMission(s.missionId, "ready", "code-monkey", "system");
    if (moved.ok) {
      columnOf[key] = "ready";
      rows.set(key, { ...(rows.get(key) as MissionRow), column: "ready" });
    }
  }

  // 2. Delivered work: review, accept, or hand to the owner.
  for (const s of link.slices) {
    if (columnOf[s.key] !== "review") continue;
    const policy = reviewPolicy(link.card.stakes, s.door);
    const m = rows.get(s.key);
    const proofLinks = [...(m?.artifacts ?? []), ...linksIn(m?.delivery ?? "")];

    if (s.goAhead) {
      // The owner already said go ahead to this one-way step; its delivery finishes it.
      const done = await boardOps.moveMission(s.missionId, "done", "code-monkey", "system");
      if (done.ok) columnOf[s.key] = "done";
      continue;
    }
    if (policy.independentReview && !s.reviewMissionId) {
      const made = await boardOps.createMission({
        title: `Review: ${s.title}`.slice(0, 120),
        objective: `Check, with a fresh pair of eyes, that "${s.title}" really does what its done checks say. You did not build it.`,
        context: `Project: ${link.card.making} — for ${link.card.forWhom}. Stakes: ${link.card.stakes}.\nWhat the builder delivered:\n${(m?.delivery ?? "").slice(0, 3000)}\nProof attached:\n${proofLinks.map((l) => `- ${l}`).join("\n") || "- none"}`,
        constraints: "Do not fix anything yourself: report. Run the tests and try it the way the owner would.",
        acceptance: [
          "Deliver one line per done check, each starting with PASS or FAIL and the evidence:",
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
    const reviewDone = !policy.independentReview || (await reviewVerdict(s.reviewMissionId)) === "pass";
    const reviewFailed = policy.independentReview && (await reviewVerdict(s.reviewMissionId)) === "fail";
    if (reviewFailed) {
      // Back to the builder with the reviewer's findings; a fresh review follows the next delivery.
      const r = await mission(s.reviewMissionId);
      await boardOps.comment(s.missionId, "code-monkey", `Independent review found problems:\n${(r?.delivery ?? "").slice(0, 2000)}`);
      const back = await boardOps.moveMission(s.missionId, "ready", "code-monkey", "system");
      if (back.ok) columnOf[s.key] = "ready";
      s.reviewMissionId = undefined;
      changed = true;
      continue;
    }
    if (reviewDone && policy.autoAccept && proofLinks.length > 0) {
      const done = await boardOps.moveMission(s.missionId, "done", "code-monkey", "system");
      if (done.ok) columnOf[s.key] = "done";
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
    const reviewPassed = !policy.independentReview || (await reviewVerdict(s.reviewMissionId)) === "pass";
    const ownerTurn = column === "review" && !s.goAhead && policy.ownerLooks && reviewPassed;
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
      proof: { summary: (m?.delivery ?? "").slice(0, 1200), links: [...(m?.artifacts ?? []), ...linksIn(m?.delivery ?? "")] },
      review: review ? { state: stateFromColumn(review.column), summary: (review.delivery ?? "").slice(0, 1200) } : undefined,
      progress: (m?.progressNote ?? "").slice(0, 300),
      proofWanted: policy.proof.map((p) => PROOF_WORDS[p]),
    });
  }

  const counts = { waiting: 0, working: 0, "needs-you": 0, checking: 0, done: 0 } as Record<SliceState, number>;
  for (const v of views) counts[v.state] += 1;
  const allDone = views.length > 0 && counts.done === views.length;
  if (changed || allDone) await saveLink(sql, userId, jobId, link, allDone ? "done" : undefined);

  return { jobId, card: link.card, stakesRaisedFrom: link.stakesRaisedFrom, slices: views, counts };
}

async function reviewVerdict(reviewMissionId: string | undefined): Promise<"pass" | "fail" | "pending"> {
  const r = await mission(reviewMissionId);
  if (!r || (r.column !== "done" && r.column !== "review")) return "pending";
  const text = String(r.delivery ?? "");
  if (/\bVERDICT\s+FAIL\b/i.test(text) || /^\s*-?\s*FAIL\b/im.test(text)) return "fail";
  if (/\bVERDICT\s+PASS\b/i.test(text)) return "pass";
  return "pending";
}

export type OwnerAction =
  | { kind: "answer"; callId: string; text: string }
  | { kind: "looks-right"; sliceKey: string }
  | { kind: "not-yet"; sliceKey: string; text: string };

/** The three things a person can do in the workshop. Everything else moves on its own. */
export async function ownerActs(sql: Sql, userId: string, jobId: string, action: OwnerAction, ownerName = "owner"): Promise<{ ok: boolean; error?: string }> {
  const link = await loadLink(sql, userId, jobId);
  if (!link) return { ok: false, error: "not_found" };
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
  if (action.kind === "looks-right") {
    if (s.door === "one-way") {
      // Approving a one-way slice is the go-ahead for the step it held back.
      s.goAhead = true;
      await boardOps.comment(s.missionId, "code-monkey", "The owner said go ahead: run the irreversible step now, then deliver with proof.");
      const back = await boardOps.moveMission(s.missionId, "ready", "code-monkey", "system");
      await saveLink(sql, userId, jobId, link);
      return { ok: back.ok };
    }
    const done = await boardOps.moveMission(s.missionId, "done", ownerName, "human");
    return { ok: done.ok };
  }
  const text = String(action.text || "").trim().slice(0, 2000);
  if (!text) return { ok: false, error: "say_what_is_wrong" };
  await boardOps.comment(s.missionId, "code-monkey", `The owner looked and said: ${text}`);
  s.reviewMissionId = undefined;
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
