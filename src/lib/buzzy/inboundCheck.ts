/**
 * CR-21 — the inbound check, facts-only v0.
 *
 * A paper arrives (paper.ts reads it into five proposed lines). This module
 * answers the other direction: "what has the owner actually confirmed on this
 * paper, where did each line come from, what is still missing, and what should
 * I ask about it?"
 *
 * The one rule that keeps v0 honest: **it quotes only a confirmed fact.** It
 * never reads buzzy_papers.body, never invents a line kind, and never writes.
 * `GET /api/buzzy/papers/:id/check` can be called twice and leave the account
 * byte-identical — there is no INSERT, UPDATE or DELETE in this file.
 *
 * What that costs, stated plainly so the reply cannot overclaim:
 *   - one-sided and missing-clause findings are OUT of v0: catching "the letter
 *     names who it is from but never who it is to" means quoting prose, and
 *     prose is not a confirmed fact;
 *   - "whether the money adds up" is OUT of v0: review.ts stays the outbound
 *     checker (checkArithmetic still needs two item lines plus a total), and
 *     this report issues no arithmetic verdict at all — see `arithmetic: null`;
 *   - a promise (a commitment sentence) is prose too, so v0 states obligations
 *     only as the five confirmed keys state them.
 *
 * A gap is reported as a gap — "No due date is confirmed" — never as a claim
 * about what the document's prose says.
 */

import type { Sql } from "@/lib/db";
import { PAPER_KEYS, type PaperKey } from "./paper";

/** The refusal a paper with no confirmed line gets. Named, never a shrug. */
export const INBOUND_NO_FACTS =
  "There is nothing confirmed on this paper for me to quote. Paste or confirm a line first.";

/** Said in every report: what this check does NOT do. */
export const INBOUND_NOTE =
  "This reads only the lines you confirmed. It adds no numbers and gives no arithmetic verdict.";

/**
 * An obligation the owner has to meet, or a plain fact about the paper.
 * asked/amount/due are what a paper asks of someone; parties/date are the
 * setting it comes in.
 */
export type InboundKind = "obligation" | "fact";

const KIND: Record<PaperKey, InboundKind> = {
  parties: "fact",
  date: "fact",
  amount: "obligation",
  asked: "obligation",
  due: "obligation",
};

/**
 * How a confirmed line is stated back. The owner's own words are quoted as they
 * confirmed them — nothing is re-worded, re-ordered or rounded.
 */
const CONFIRMED: Record<PaperKey, (value: string) => string> = {
  parties: (v) => `You confirmed the parties: ${v}.`,
  date: (v) => `You confirmed the date: ${v}.`,
  amount: (v) => `You confirmed the amount: ${v}.`,
  asked: (v) => `You confirmed what's being asked: ${v}.`,
  due: (v) => `You confirmed the due date: ${v}.`,
};

/**
 * The same five words paper.ts shows on the panel. Duplicated on purpose: 10591
 * says paper.ts stays untouched, and a gap has no fact row to borrow a label
 * from. Keys come from PAPER_KEYS, so a sixth key is a type error here.
 */
const LABELS: Record<PaperKey, string> = {
  parties: "Who it's between",
  date: "The date",
  amount: "The amount",
  asked: "What's being asked",
  due: "The due date",
};

/** A gap is about the confirmation, not about the page. */
const GAP_SAID: Record<PaperKey, string> = {
  parties: "No parties are confirmed on this paper.",
  date: "No date is confirmed on this paper.",
  amount: "No amount is confirmed on this paper.",
  asked: "Nothing is confirmed about what this paper is asking for.",
  due: "No due date is confirmed on this paper.",
};

/** The question a gap asks, once a confirmed line is there to stand on. */
const GAP_QUESTION: Record<PaperKey, string> = {
  parties: "Who is it between?",
  date: "What date should the reply carry?",
  amount: "How much is owed?",
  asked: "What is it asking for?",
  due: "What date is it due?",
};

export interface InboundFinding {
  key: PaperKey;
  label: string;
  kind: InboundKind;
  /** Exactly what the owner confirmed. Never a derived number or a guess. */
  value: string;
  /** Where that line was confirmed from — "the file X", "page 1 of the letter you pasted". Never empty. */
  place: string;
  /** One sentence the chat may say: "You confirmed the amount: $1,250.00." */
  sentence: string;
  /** Short board-chip form: "The amount: $1,250.00". */
  title: string;
}

export interface InboundGap {
  key: PaperKey;
  label: string;
  sentence: string;
}

export interface InboundQuestion {
  question: string;
  /** The missing line this question is about. */
  about: PaperKey;
  /**
   * The confirmed line the question stands on. Null when the question stands on
   * the gap itself (there is no confirmed line to lead with).
   */
  fact: { key: PaperKey; value: string; place: string } | null;
}

export interface InboundReport {
  paperId: string;
  jobId: string | null;
  kind: string;
  filename: string;
  /** The paper's own place, as stored when it was read. */
  place: string;
  /** How many confirmed lines this report quotes. A confirmed line with no recorded place is counted in `uncited`, not here. */
  confirmed: number;
  findings: InboundFinding[];
  gaps: InboundGap[];
  /**
   * Confirmed lines this check refused to quote because no place was recorded
   * for them. Should never happen (paper.ts always stores a place); it exists so
   * a missing place can never turn into a finding without one.
   */
  uncited: Array<{ key: PaperKey; label: string; sentence: string }>;
  questions: InboundQuestion[];
  /** v0 issues no arithmetic verdict. Named null so nobody reads a silence as a pass. */
  arithmetic: null;
  note: string;
  /** One paragraph the chat may say instead of composing its own. */
  reply: string;
}

/** Confirmed rows straight from buzzy_paper_facts. Only these four fields are read. */
export interface InboundFactRow {
  fact_key: string;
  label: string;
  value: string;
  place: string;
}

export type InboundCheckResult =
  | { ok: true; check: InboundReport }
  | { ok: false; status: number; code: string; error: string };

function isPaperKey(k: string): k is PaperKey {
  return (PAPER_KEYS as readonly string[]).includes(k);
}

function tie(f: InboundFinding): { key: PaperKey; value: string; place: string } {
  return { key: f.key, value: f.value, place: f.place };
}

/**
 * The report, from confirmed rows only. Pure: no SQL, no clock, no randomness —
 * the same facts always produce the same report (and the same card ids).
 */
export function inboundReport(input: {
  paperId: string;
  jobId: string | null;
  kind: string;
  filename: string;
  place: string;
  facts: InboundFactRow[];
}): InboundReport {
  // One confirmed row per key; the first one read wins. A key we do not know is
  // not a paper key (a later line kind), so it is not quoted here.
  const byKey = new Map<PaperKey, InboundFactRow>();
  for (const f of input.facts) {
    if (!isPaperKey(f.fact_key)) continue;
    const value = String(f.value ?? "").trim();
    if (!value) continue;
    if (!byKey.has(f.fact_key)) byKey.set(f.fact_key, { ...f, value });
  }

  const findings: InboundFinding[] = [];
  const uncited: Array<{ key: PaperKey; label: string; sentence: string }> = [];
  for (const key of PAPER_KEYS) {
    const row = byKey.get(key);
    if (!row) continue;
    // A confirmed line with no recorded place cannot be cited: a finding without
    // a place is exactly what this CR must never emit. It is named in `uncited`
    // instead, never quoted.
    const place = String(row.place ?? "").trim();
    if (!place) {
      uncited.push({
        key,
        label: String(row.label || "").trim() || key,
        sentence: `A line is confirmed for ${key}, but no place was recorded for it, so I can't quote it.`,
      });
      continue;
    }
    const label = String(row.label || "").trim() || key;
    findings.push({
      key,
      label,
      kind: KIND[key],
      value: row.value,
      place,
      sentence: CONFIRMED[key](row.value),
      title: `${label}: ${row.value}`,
    });
  }

  // Gaps are keys with nothing confirmed at all. A key that IS confirmed but had
  // no place is in `uncited`, not here — "No amount is confirmed" would be false.
  const gaps: InboundGap[] = PAPER_KEYS.filter((k) => !byKey.has(k)).map((k) => ({
    key: k,
    label: LABELS[k],
    sentence: GAP_SAID[k],
  }));

  // Up to three questions, each standing on a confirmed line. One question per
  // missing key; the lead-in is the confirmed sentence itself, so the tie is
  // visible to the owner and to whoever reads the JSON. The anchor rotates so
  // three questions do not all begin with the same line.
  const questions: InboundQuestion[] = [];
  let anchorAt = 0;
  for (const gap of gaps) {
    if (questions.length >= 3) break;
    const anchor = findings[anchorAt % findings.length];
    if (!anchor) continue;
    anchorAt += 1;
    questions.push({
      question: `${anchor.sentence} ${GAP_QUESTION[gap.key]}`,
      about: gap.key,
      fact: tie(anchor),
    });
  }

  const replyParts = [
    `I'll quote only the lines you confirmed on this paper: ${findings.length}.`,
    ...findings.map((f) => `${f.sentence} That is from ${f.place}.`),
    ...uncited.map((u) => u.sentence),
    ...gaps.map((g) => g.sentence),
    ...questions.map((q) => q.question),
    INBOUND_NOTE,
    "Nothing is sent or filed from this.",
  ];

  return {
    paperId: input.paperId,
    jobId: input.jobId,
    kind: input.kind,
    filename: input.filename,
    place: input.place,
    confirmed: findings.length,
    findings,
    gaps,
    uncited,
    questions,
    arithmetic: null,
    note: INBOUND_NOTE,
    reply: replyParts.join(" "),
  };
}

function notFound(): InboundCheckResult {
  return { ok: false, status: 404, code: "not_found", error: "That paper isn't on your account." };
}

/**
 * GET /api/buzzy/papers/:id/check — the read.
 *
 * Read-only by construction: two queries, no writes. The paper's body is never
 * selected. Another owner's paper is a 404 (same answer as a paper that does not
 * exist), and a locked PDF never has a row at all — savePaper refuses it with
 * locked_pdf before any INSERT — so it is a 404 here too.
 */
export async function inboundCheck(sql: Sql, userId: string, paperId: string): Promise<InboundCheckResult> {
  if (!/^pp_[a-z0-9]{8,32}$/.test(paperId)) return notFound();

  const papers = await sql.query<{
    id: string;
    job_id: string | null;
    filename: string;
    kind: string;
    place: string;
  }>(
    // No `body`: this check cites confirmed lines, not prose.
    `SELECT id, job_id, filename, kind, place
       FROM buzzy_papers
      WHERE id = $1 AND user_id = $2
      LIMIT 1`,
    [paperId, userId],
  );
  if (!papers.length) return notFound();

  const facts = await sql.query<InboundFactRow>(
    // Confirmed and not blank. A blank line cannot be confirmed at all
    // (updatePaperLine refuses it), so a whitespace value never lands here —
    // btrim is the second lock, not the only one.
    `SELECT fact_key, label, value, place
       FROM buzzy_paper_facts
      WHERE paper_id = $1 AND user_id = $2
        AND status = 'confirmed'
        AND btrim(value) <> ''
      ORDER BY created_at ASC`,
    [paperId, userId],
  );

  if (!facts.length) {
    // 200, not 4xx: the paper is the owner's and the answer is a sentence about
    // it ("nothing is confirmed yet"), not a failed request. The body still says
    // ok:false so a caller cannot mistake it for a report.
    return { ok: false, status: 200, code: "no_confirmed_fact", error: INBOUND_NO_FACTS };
  }

  const row = papers[0];
  return {
    ok: true,
    check: inboundReport({
      paperId: row.id,
      jobId: row.job_id,
      kind: row.kind,
      filename: row.filename,
      place: row.place,
      facts,
    }),
  };
}

/** The tool the owner's confirmed lines are read through (toolRegistry gate "paper"). */
export const CHECK_PAPER_TOOL = {
  type: "function",
  function: {
    name: "check_paper",
    description:
      "Read back the lines the owner has CONFIRMED on the paper in this job: parties, date, amount, ask, due — " +
      "each with the place it came from — plus what is still unconfirmed and up to three questions. " +
      "It quotes only confirmed lines. It adds no numbers and gives no arithmetic verdict. " +
      "Never state a line this tool did not return.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
} as const;

/** The four columns already on a Talk job (talk.html emptyJob / goBoard, and savePaper's new job). */
export const INBOUND_COLUMNS = ["Waiting", "Working", "Needs you", "Done"] as const;
export type InboundColumn = (typeof INBOUND_COLUMNS)[number];

export interface InboundCard {
  /** Stable and deterministic: the same paper and key always make the same id. */
  id: string;
  title: string;
  note: string;
  /** Where the line came from. Null only for a card that stands on a gap. */
  place: string | null;
  column: InboundColumn;
}

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n).trim() : t;
}

/**
 * The cards the tap would write onto job.data.board — built here, written
 * nowhere. CR-21's head is the read; writing cards is a separate write surface
 * (the tap), so this function only says what that tap would place:
 *   - a confirmed obligation → Waiting (not started, never Done by this check);
 *   - a question the owner must answer → Needs you;
 *   - a gap → no card. A gap stays a gap; there is nothing to put on the board.
 */
export function inboundCards(report: InboundReport): InboundCard[] {
  const cards: InboundCard[] = [];
  for (const f of report.findings) {
    cards.push({
      id: `inbound:${report.paperId}:${f.key}`,
      title: clip(f.title, 90),
      note: f.sentence,
      place: f.place,
      column: "Waiting",
    });
  }
  report.questions.forEach((q, i) => {
    cards.push({
      id: `inbound:${report.paperId}:q${i + 1}`,
      title: clip(q.question, 90),
      note: q.fact ? `${q.fact.value} — from ${q.fact.place}` : GAP_SAID[q.about],
      place: q.fact?.place ?? null,
      column: "Needs you",
    });
  });
  return cards;
}
