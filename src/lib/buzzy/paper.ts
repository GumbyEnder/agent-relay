/**
 * Read a dropped or pasted paper into proposed lines.
 * The page is data, not instructions. Nothing is confirmed here.
 * Later skills may use only lines the owner has accepted.
 */

import { inflateSync } from "node:zlib";
import type { Sql } from "@/lib/db";

export const PAPER_KEYS = ["parties", "date", "amount", "asked", "due"] as const;
export type PaperKey = (typeof PAPER_KEYS)[number];

const LABELS: Record<PaperKey, string> = {
  parties: "Who it's between",
  date: "The date",
  amount: "The amount",
  asked: "What's being asked",
  due: "The due date",
};

export type ReadStatus = "proposed" | "unknown";

export interface ReadFact {
  key: PaperKey;
  label: string;
  value: string;
  status: ReadStatus;
  place: string;
}

export interface PaperRead {
  kind: string;
  place: string;
  sentence: string;
  question: string | null;
  gaps: string[];
  facts: ReadFact[];
  /** What the chat may store. No unconfirmed amount is stated as fact. */
  reply: string;
}

export interface PaperFactPayload {
  id: string;
  key: string;
  label: string;
  value: string;
  status: string;
  place: string;
  source: string;
}

export interface PaperPayload {
  id: string;
  jobId: string | null;
  companyId: string;
  filename: string;
  kind: string;
  place: string;
  sentence: string;
  question: string | null;
  gaps: string[];
  text: string;
  reply: string;
  facts: PaperFactPayload[];
  /** Confirmed lines only. Proposed and unknown are not in here. */
  accepted: Array<{ key: string; label: string; value: string }>;
}

const INSTRUCTION =
  /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above)\s+instructions|disregard\s+(?:your|all|the)\s+(?:instructions|rules|prompt)|you\s+are\s+now\b|system\s+prompt|\[system\]|new\s+instructions\s*:|do\s+not\s+(?:follow|obey)\s+your/i;

const MONEY = /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\b\d{1,3}(?:,\d{3})*\.\d{2}\b/g;

const DATE =
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2},?\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/i;

const FROM_RE = /^(?:from|vendor|supplier|issued by|billed from|seller)\s*[:\-]\s*(.+)$/i;
const TO_RE = /^(?:to|bill to|billed to|sold to|customer|client)\s*[:\-]\s*(.+)$/i;
const ASK_RE = /^(?:for|description|re|subject|regarding|services|work)\s*[:\-]\s*(.+)$/i;

function cleanLine(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function isInstruction(line: string): boolean {
  return INSTRUCTION.test(line);
}

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n).trim() : t;
}

function moneyNumber(token: string): string {
  const n = Number(token.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n.toFixed(2) : token;
}

function fuzzyAmount(line: string): boolean {
  return /\b(about|around|approx(?:imately)?|roughly|maybe)\b/i.test(line) || /\$\s?\d[\d,]*\s*\?/.test(line) || /~\s*\$/.test(line);
}

function amountRank(line: string): number {
  const l = line.toLowerCase();
  if (/(amount|balance|total)\s+due|\bdue\s+now\b/.test(l)) return 3;
  if (/grand\s+total|\btotal\b/.test(l) && !/subtotal/.test(l)) return 2;
  if (/\bamount\b/.test(l) && !/subtotal/.test(l)) return 2;
  if (/subtotal|\btax\b|shipping|discount/.test(l)) return 0;
  return 1;
}

function dueLine(line: string): boolean {
  return /\bdue date\b|\bpayment due\b|\bpay by\b|\bpayable by\b|^due\b/i.test(line);
}

function dateLine(line: string): boolean {
  return /\binvoice date\b|\bdate of invoice\b|^date\b|\bdated\b|\bissued\b/i.test(line) && !dueLine(line);
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function similarNames(a: string, b: string): boolean {
  const x = normName(a);
  const y = normName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length > 4 && y.length > 4 && (x.includes(y) || y.includes(x))) return true;
  return false;
}

function blankFacts(place: string): ReadFact[] {
  return PAPER_KEYS.map((key) => ({
    key,
    label: LABELS[key],
    value: "",
    status: "unknown" as const,
    place,
  }));
}

function unescapePdf(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "")
    .replace(/\\t/g, " ")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}

function pdfLiterals(s: string): string {
  const out: string[] = [];
  const re = /\((?:\\.|[^\\)])*\)(\s*Tj)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const raw = m[0];
    const lineBreak = /\sTj$/.test(raw);
    const lit = raw.replace(/\s*Tj$/, "");
    const text = unescapePdf(lit.slice(1, -1));
    if (!text) continue;
    out.push(text + (lineBreak ? "\n" : " "));
  }
  return out.join("");
}

/** Pull visible text out of a simple PDF. Empty when the page has no text layer. */
export function textFromPdf(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  const parts: string[] = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const head = raw.slice(Math.max(0, m.index - 400), m.index);
    let data: Buffer = Buffer.from(m[1], "latin1");
    if (/FlateDecode/.test(head)) {
      try {
        data = inflateSync(data);
      } catch {
        continue;
      }
    }
    parts.push(pdfLiterals(data.toString("latin1")));
  }
  const joined = parts.join("\n").trim();
  if (joined) return joined.replace(/[ \t]{2,}/g, " ");
  return pdfLiterals(raw).replace(/[ \t]{2,}/g, " ").trim();
}

function kindOf(text: string): string {
  const head = text.slice(0, 600);
  if (/\binvoice\b/i.test(head)) return "invoice";
  if (/\b(quote|quotation|estimate)\b/i.test(head)) return "quote";
  if (/\bnotice\b/i.test(head)) return "notice";
  if (/\bform\b/i.test(head)) return "form";
  if (/^\s*dear\b/im.test(text)) return "letter";
  return "paper";
}

function noun(kind: string): string {
  if (kind === "paper") return "paper";
  return kind;
}

/**
 * Read parties, date, amount, ask, and due date off the page.
 * A line that tells BeeZilla what to do is dropped before any field is taken.
 * A missing or fuzzy field stays unknown. No line is confirmed.
 */
export function readPaper(input: {
  text: string;
  filename?: string;
  fileKind?: "text" | "pdf" | "photo" | "paste";
  unreadable?: boolean;
}): PaperRead {
  const filename = (input.filename || "").trim();
  const fileKind = input.fileKind || "paste";
  const basePlace =
    fileKind === "photo"
      ? "the photo you dropped"
      : fileKind === "paste" || !filename
        ? "the letter you pasted"
        : `the file ${filename}`;

  const unread = input.unreadable || fileKind === "photo" || !String(input.text || "").trim();
  if (unread) {
    const sentence = "I couldn't read the words on this. The lines stay unknown until you fill them in.";
    return {
      kind: fileKind === "photo" ? "photo" : "paper",
      place: basePlace,
      sentence,
      question: null,
      gaps: [],
      facts: blankFacts(basePlace),
      reply: `${sentence} Nothing is sent or filed from this.`,
    };
  }

  const rawLines = String(input.text).replace(/\r\n/g, "\n").split("\n");
  const lines: string[] = [];
  for (const raw of rawLines) {
    const line = cleanLine(raw);
    if (!line) continue;
    if (isInstruction(line)) continue;
    lines.push(line);
  }
  const text = lines.join("\n");
  if (!text.trim()) {
    return readPaper({ text: "", filename, fileKind, unreadable: true });
  }

  const pageMatch = text.match(/page\s+(\d+)\s+of\s+(\d+)/i);
  const page = pageMatch
    ? { n: Number(pageMatch[1]), of: Number(pageMatch[2]) }
    : null;
  const place = page ? `page ${page.n} of ${basePlace}` : basePlace;
  const gaps: string[] = [];
  if (page && page.of > page.n) {
    gaps.push(`This file says it is page ${page.n} of ${page.of}. The other pages were not included.`);
  }

  const froms: string[] = [];
  const tos: string[] = [];
  for (const line of lines) {
    const f = line.match(FROM_RE);
    if (f) froms.push(clip(f[1], 80));
    const t = line.match(TO_RE);
    if (t) tos.push(clip(t[1], 80));
  }

  let parties = "";
  let partiesStatus: ReadStatus = "unknown";
  let nameQuestion: string | null = null;
  const distinctTo = [...new Set(tos)];
  if (distinctTo.length > 1) {
    nameQuestion = `Which name is the customer — ${distinctTo.slice(0, 2).join(" or ")}?`;
  } else if (froms[0] && tos[0] && similarNames(froms[0], tos[0])) {
    nameQuestion = `Which name is the customer — ${froms[0]} or ${tos[0]}?`;
  } else if (froms[0] && tos[0]) {
    parties = `From ${froms[0]} to ${tos[0]}`;
    partiesStatus = "proposed";
  } else if (froms[0] || tos[0]) {
    parties = froms[0] || tos[0];
    partiesStatus = "proposed";
  }

  let date = "";
  let dateStatus: ReadStatus = "unknown";
  for (const line of lines) {
    if (!dateLine(line) || dueLine(line)) continue;
    const found = line.match(DATE);
    if (found) {
      date = found[0];
      dateStatus = "proposed";
      break;
    }
    if (fuzzyAmount(line) || /\b(sometime|next week|soon)\b/i.test(line)) {
      date = clip(line, 80);
      dateStatus = "unknown";
      break;
    }
  }

  type Hit = { token: string; rank: number; fuzzy: boolean; line: string };
  const hits: Hit[] = [];
  for (const line of lines) {
    const tokens = line.match(MONEY) || [];
    const fuzzy = fuzzyAmount(line);
    const rank = amountRank(line);
    for (const token of tokens) hits.push({ token, rank, fuzzy, line });
  }
  const strong = hits.filter((h) => h.rank >= 2 && !h.fuzzy);
  const strongDistinct = [...new Map(strong.map((h) => [moneyNumber(h.token), h])).values()];
  let amount = "";
  let amountStatus: ReadStatus = "unknown";
  let amountQuestion: string | null = null;
  if (strongDistinct.length === 1) {
    amount = strongDistinct[0].token.replace(/\s+/g, "");
    amountStatus = "proposed";
  } else if (strongDistinct.length > 1) {
    amountQuestion = `The page shows more than one total (${strongDistinct
      .slice(0, 3)
      .map((h) => h.token.replace(/\s+/g, ""))
      .join(" and ")}). Which amount do you mean?`;
  } else {
    const weak = hits.filter((h) => h.rank === 1 && !h.fuzzy);
    const weakDistinct = [...new Map(weak.map((h) => [moneyNumber(h.token), h])).values()];
    if (weakDistinct.length === 1) {
      amount = weakDistinct[0].token.replace(/\s+/g, "");
      amountStatus = "proposed";
    } else if (weakDistinct.length > 1) {
      amountQuestion = `The page shows more than one total (${weakDistinct
        .slice(0, 3)
        .map((h) => h.token.replace(/\s+/g, ""))
        .join(" and ")}). Which amount do you mean?`;
    } else {
      const fuzzyHit = hits.find((h) => h.fuzzy);
      if (fuzzyHit) amount = clip(fuzzyHit.line, 80);
    }
  }

  let asked = "";
  let askedStatus: ReadStatus = "unknown";
  for (const line of lines) {
    const m = line.match(ASK_RE);
    if (m && clip(m[1], 200)) {
      asked = clip(m[1], 200);
      askedStatus = "proposed";
      break;
    }
  }
  if (!asked) {
    const please = lines.find((l) => /^please\b/i.test(l) && !isInstruction(l));
    if (please) {
      asked = clip(please, 200);
      askedStatus = "proposed";
    }
  }

  let due = "";
  let dueStatus: ReadStatus = "unknown";
  for (const line of lines) {
    if (!dueLine(line)) continue;
    const found = line.match(DATE);
    if (found) {
      due = found[0];
      dueStatus = "proposed";
      break;
    }
  }
  if (!due) {
    const net = lines.find((l) => dueLine(l) && /\bnet\s+\d+\b/i.test(l));
    if (net) {
      const m = net.match(/\bnet\s+\d+\b/i);
      due = m ? m[0] : clip(net, 40);
      dueStatus = "unknown";
    }
  }

  const kind = kindOf(text);
  const sentence = `You'll get a short list of what this ${noun(kind)} says. Each line stays proposed until you accept it.`;
  const question = nameQuestion || amountQuestion;
  const values: Record<PaperKey, { value: string; status: ReadStatus }> = {
    parties: { value: partiesStatus === "proposed" ? parties : "", status: partiesStatus },
    date: { value: date, status: dateStatus },
    amount: { value: amount, status: amountStatus },
    asked: { value: asked, status: askedStatus },
    due: { value: due, status: dueStatus },
  };
  const facts: ReadFact[] = PAPER_KEYS.map((key) => ({
    key,
    label: LABELS[key],
    value: values[key].value,
    status: values[key].status,
    place,
  }));
  const reply = [sentence, question, "Nothing is sent or filed from this."].filter(Boolean).join(" ");
  return { kind, place, sentence, question, gaps, facts, reply };
}

function newId(prefix: string): string {
  return prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

export function cleanFilename(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const base = raw.replace(/\\/g, "/").split("/").pop() || "";
  return base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180);
}

function sourceOf(status: string, value: string, original: string): string {
  if (status === "proposed") return "Proposed";
  if (status === "unknown") return "Unknown";
  if (status === "confirmed" && original && value !== original) return "You corrected this";
  if (status === "confirmed" && !original && value) return "You added this";
  if (status === "confirmed") return "You confirmed this";
  return status;
}

type FactRow = {
  id: string;
  paper_id: string;
  fact_key: string;
  label: string;
  value: string;
  status: string;
  place: string;
  original_value: string;
};

type PaperRow = {
  id: string;
  company_id: string;
  job_id: string | null;
  filename: string;
  kind: string;
  place: string;
  body: string;
};

function isCompanyId(id: string): boolean {
  return /^co_[a-z0-9]{8,32}$/.test(id);
}

function payloadFrom(row: PaperRow, facts: FactRow[], read: { sentence: string; question: string | null; gaps: string[]; reply: string }): PaperPayload {
  const visible = facts.filter((f) => f.status !== "dropped");
  const mapped = visible.map((f) => ({
    id: f.id,
    key: f.fact_key,
    label: f.label,
    value: f.value,
    status: f.status,
    place: f.place,
    source: sourceOf(f.status, f.value, f.original_value),
  }));
  return {
    id: row.id,
    jobId: row.job_id,
    companyId: row.company_id,
    filename: row.filename,
    kind: row.kind,
    place: row.place,
    sentence: read.sentence,
    question: read.question,
    gaps: read.gaps,
    text: row.body,
    reply: read.reply,
    facts: mapped,
    accepted: mapped
      .filter((f) => f.status === "confirmed" && f.value.trim())
      .map((f) => ({ key: f.key, label: f.label, value: f.value })),
  };
}

const READ_META = /^BZMETA\t([\s\S]*)$/;

function packBody(read: PaperRead, text: string): string {
  const meta = JSON.stringify({
    sentence: read.sentence,
    question: read.question,
    gaps: read.gaps,
    reply: read.reply,
  });
  return `BZMETA\t${meta}\n${text}`;
}

function unpackBody(body: string): { sentence: string; question: string | null; gaps: string[]; reply: string; text: string } {
  const nl = body.indexOf("\n");
  const first = nl === -1 ? body : body.slice(0, nl);
  const rest = nl === -1 ? "" : body.slice(nl + 1);
  const m = first.match(READ_META);
  if (!m) {
    return {
      sentence: "You'll get a short list of what this paper says. Each line stays proposed until you accept it.",
      question: null,
      gaps: [],
      reply: "Each line stays proposed until you accept it. Nothing is sent or filed from this.",
      text: body,
    };
  }
  try {
    const obj = JSON.parse(m[1]) as {
      sentence?: string;
      question?: string | null;
      gaps?: string[];
      reply?: string;
    };
    return {
      sentence: obj.sentence || "",
      question: obj.question || null,
      gaps: Array.isArray(obj.gaps) ? obj.gaps.filter((g) => typeof g === "string") : [],
      reply: obj.reply || obj.sentence || "",
      text: rest,
    };
  } catch {
    return { sentence: "", question: null, gaps: [], reply: "", text: rest };
  }
}

async function loadPaper(sql: Sql, userId: string, paperId: string): Promise<PaperPayload | null> {
  const rows = await sql<PaperRow>`
    SELECT id, company_id, job_id, filename, kind, place, body
    FROM buzzy_papers
    WHERE id = ${paperId} AND user_id = ${userId}
    LIMIT 1
  `;
  if (!rows.length) return null;
  const facts = await sql<FactRow>`
    SELECT id, paper_id, fact_key, label, value, status, place, original_value
    FROM buzzy_paper_facts
    WHERE paper_id = ${paperId} AND user_id = ${userId}
    ORDER BY created_at ASC
  `;
  const meta = unpackBody(rows[0].body || "");
  const row = { ...rows[0], body: meta.text.slice(0, 20000) };
  return payloadFrom(row, facts, meta);
}

export async function acceptedPaperFacts(
  sql: Sql,
  userId: string,
  opts: { companyId: string; jobId?: string | null },
): Promise<Array<{ key: string; label: string; value: string; paperId: string }>> {
  if (!isCompanyId(opts.companyId)) return [];
  const rows = opts.jobId
    ? await sql<{ fact_key: string; label: string; value: string; paper_id: string }>`
        SELECT fact_key, label, value, paper_id
        FROM buzzy_paper_facts
        WHERE user_id = ${userId}
          AND company_id = ${opts.companyId}
          AND job_id = ${opts.jobId}
          AND status = 'confirmed'
          AND value <> ''
        ORDER BY updated_at ASC
      `
    : await sql<{ fact_key: string; label: string; value: string; paper_id: string }>`
        SELECT fact_key, label, value, paper_id
        FROM buzzy_paper_facts
        WHERE user_id = ${userId}
          AND company_id = ${opts.companyId}
          AND status = 'confirmed'
          AND value <> ''
        ORDER BY updated_at ASC
      `;
  return rows.map((r) => ({
    key: r.fact_key,
    label: r.label,
    value: r.value,
    paperId: r.paper_id,
  }));
}

function jobTitleFor(read: PaperRead, filename: string): string {
  if (filename) return filename.slice(0, 120);
  if (read.kind === "invoice") return "Invoice you dropped";
  if (read.kind === "quote") return "Quote you dropped";
  if (read.kind === "letter") return "Letter you dropped";
  return "Paper you dropped";
}

export async function savePaper(
  sql: Sql,
  userId: string,
  input: {
    companyId: string;
    jobId: string | null;
    sessionId: string | null;
    filename: string;
    text: string;
    fileKind: "text" | "pdf" | "photo" | "paste";
    pdfBytes?: Uint8Array | null;
  },
): Promise<{ ok: true; paper: PaperPayload } | { ok: false; error: string; code: string; status: number }> {
  if (!isCompanyId(input.companyId)) {
    return { ok: false, error: "Pick the company this paper belongs to first.", code: "bad_company", status: 400 };
  }
  const owned = await sql`
    SELECT id FROM buzzy_companies WHERE id = ${input.companyId} AND user_id = ${userId}
  `;
  if (!owned.length) {
    return { ok: false, error: "That company isn't on your account.", code: "bad_company", status: 400 };
  }

  let text = input.fileKind === "photo" ? "" : input.text.slice(0, 80000);
  let unreadable = input.fileKind === "photo";
  let locked = false;
  if (input.fileKind === "pdf") {
    // BZ-F007: encrypted PDFs get their own next action — "unlock it" is more
    // useful than a generic unreadable. Deterministic marker scan, no parser.
    if (input.pdfBytes && input.pdfBytes.length) {
      const head = Buffer.from(input.pdfBytes.slice(0, 65536)).toString("latin1");
      locked = /\/Encrypt\b/.test(head);
    }
    try {
      text = locked || !input.pdfBytes?.length ? "" : textFromPdf(input.pdfBytes).slice(0, 80000);
    } catch {
      text = "";
    }
    unreadable = text.trim().length < 12;
  }
  if (locked) {
    return { ok: false, error: "That PDF is locked with a password. Open it on your device, then paste the text here instead.", code: "locked_pdf", status: 422 };
  }

  const read = readPaper({
    text,
    filename: input.filename,
    fileKind: input.fileKind,
    unreadable,
  });

  let jobId = input.jobId;
  if (jobId) {
    const jobs = await sql<{ company_id: string | null }>`
      SELECT company_id FROM buzzy_jobs WHERE id = ${jobId} AND user_id = ${userId} LIMIT 1
    `;
    if (!jobs.length) {
      return { ok: false, error: "That job isn't on your account.", code: "not_found", status: 404 };
    }
    const on = jobs[0].company_id;
    if (on && on !== input.companyId) {
      return { ok: false, error: "That job is on another company.", code: "bad_company", status: 400 };
    }
    await sql`
      UPDATE buzzy_jobs
      SET updated_at = now(), company_id = COALESCE(company_id, ${input.companyId})
      WHERE id = ${jobId} AND user_id = ${userId}
    `;
  } else {
    jobId = newId("job_");
    const title = jobTitleFor(read, input.filename);
    const data = {
      id: jobId,
      companyId: input.companyId,
      title,
      template: null,
      problem: "",
      messages: [],
      screen: "jobs",
      answers: {},
      skipped: {},
      version: 0,
      approved: false,
      status: "Not started",
      board: { Waiting: [], Working: [], "Needs you": [], Done: [] },
      events: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const dataJson = JSON.stringify(data);
    await sql`
      INSERT INTO buzzy_jobs (id, user_id, template, title, status, company_id, data, updated_at)
      VALUES (${jobId}, ${userId}, ${null}, ${title}, ${"Not started"}, ${input.companyId}, ${dataJson}::jsonb, now())
    `;
  }

  if (input.sessionId && /^[A-Za-z0-9_-]{4,80}$/.test(input.sessionId)) {
    const sessions = await sql<{ company_id: string | null }>`
      SELECT company_id FROM buzzy_sessions
      WHERE id = ${input.sessionId} AND user_id = ${userId}
      LIMIT 1
    `;
    const sc = sessions[0]?.company_id;
    if (sessions.length && (!sc || sc === input.companyId)) {
      await sql`
        UPDATE buzzy_sessions
        SET job_id = COALESCE(job_id, ${jobId}),
            company_id = COALESCE(company_id, ${input.companyId}),
            updated_at = now()
        WHERE id = ${input.sessionId} AND user_id = ${userId}
      `;
      const note = input.filename ? `Read this — ${input.filename}` : "Read this.";
      await sql`
        INSERT INTO buzzy_chat_messages (user_id, job_id, session_id, role, content)
        VALUES (${userId}, ${jobId}, ${input.sessionId}, 'user', ${note})
      `;
      await sql`
        INSERT INTO buzzy_chat_messages (user_id, job_id, session_id, role, content)
        VALUES (${userId}, ${jobId}, ${input.sessionId}, 'assistant', ${read.reply})
      `;
    }
  }

  const paperId = newId("pp_");
  const body = packBody(read, text);
  await sql`
    INSERT INTO buzzy_papers (id, user_id, company_id, job_id, session_id, filename, kind, place, body)
    VALUES (
      ${paperId}, ${userId}, ${input.companyId}, ${jobId}, ${input.sessionId},
      ${input.filename}, ${read.kind}, ${read.place}, ${body}
    )
  `;
  for (const fact of read.facts) {
    const id = newId("pf_");
    const original = fact.status === "proposed" || fact.value ? fact.value : "";
    await sql`
      INSERT INTO buzzy_paper_facts
        (id, paper_id, user_id, company_id, job_id, fact_key, label, value, status, place, original_value)
      VALUES (
        ${id}, ${paperId}, ${userId}, ${input.companyId}, ${jobId},
        ${fact.key}, ${fact.label}, ${fact.value}, ${fact.status}, ${fact.place}, ${original}
      )
    `;
  }
  const paper = await loadPaper(sql, userId, paperId);
  if (!paper) {
    return { ok: false, error: "Couldn't keep that paper.", code: "store", status: 500 };
  }
  return { ok: true, paper };
}

export async function latestPaper(
  sql: Sql,
  userId: string,
  companyId: string,
  jobId?: string | null,
): Promise<PaperPayload | null> {
  if (!isCompanyId(companyId)) return null;
  const rows = jobId
    ? await sql<{ id: string }>`
        SELECT id FROM buzzy_papers
        WHERE user_id = ${userId} AND company_id = ${companyId} AND job_id = ${jobId}
        ORDER BY created_at DESC
        LIMIT 1
      `
    : await sql<{ id: string }>`
        SELECT id FROM buzzy_papers
        WHERE user_id = ${userId} AND company_id = ${companyId}
        ORDER BY created_at DESC
        LIMIT 1
      `;
  if (!rows.length) return null;
  return loadPaper(sql, userId, rows[0].id);
}

export async function updatePaperLine(
  sql: Sql,
  userId: string,
  paperId: string,
  lineId: string,
  action: "confirm" | "edit" | "drop",
  value?: string | null,
): Promise<{ ok: true; paper: PaperPayload } | { ok: false; error: string; code: string; status: number }> {
  if (!/^pp_[a-z0-9]{8,32}$/.test(paperId) || !/^pf_[a-z0-9]{8,32}$/.test(lineId)) {
    return { ok: false, error: "That line isn't on this paper.", code: "bad_request", status: 400 };
  }
  const rows = await sql<{ id: string; value: string; status: string; paper_id: string }>`
    SELECT id, value, status, paper_id
    FROM buzzy_paper_facts
    WHERE id = ${lineId} AND paper_id = ${paperId} AND user_id = ${userId}
    LIMIT 1
  `;
  if (!rows.length || rows[0].status === "dropped") {
    return { ok: false, error: "That line isn't on this paper.", code: "not_found", status: 404 };
  }
  if (action === "drop") {
    await sql`
      UPDATE buzzy_paper_facts
      SET status = 'dropped', updated_at = now()
      WHERE id = ${lineId} AND user_id = ${userId}
    `;
  } else if (action === "confirm") {
    if (!rows[0].value.trim()) {
      return { ok: false, error: "That line is still blank.", code: "bad_request", status: 400 };
    }
    await sql`
      UPDATE buzzy_paper_facts
      SET status = 'confirmed', updated_at = now()
      WHERE id = ${lineId} AND user_id = ${userId}
    `;
  } else {
    const next = (value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 280);
    if (!next) {
      return { ok: false, error: "Type the corrected line.", code: "bad_request", status: 400 };
    }
    await sql`
      UPDATE buzzy_paper_facts
      SET status = 'confirmed', value = ${next}, updated_at = now()
      WHERE id = ${lineId} AND user_id = ${userId}
    `;
  }
  const paper = await loadPaper(sql, userId, paperId);
  if (!paper) {
    return { ok: false, error: "That paper isn't on your account.", code: "not_found", status: 404 };
  }
  return { ok: true, paper };
}
