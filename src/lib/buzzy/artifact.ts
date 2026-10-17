/**
 * Buzzy artifact renderer — Phase 1 proving slice (plan doc 23).
 *
 * ARTIFACT RULE (non-negotiable): the model NEVER writes file bytes. It emits
 * a typed content object; this module validates it against a schema and
 * renders it deterministically with the docx library. The render output is
 * byte-identical for identical input.
 *
 * Phase 1 scope: render_document ({ title, sections }) -> real .docx.
 */

import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

/** A section of the document: heading + paragraph list. */
export interface DocSection {
  heading: string;
  paragraphs: string[];
}

/** Typed content the model must emit for render_document. */
export interface DocumentContent {
  title: string;
  sections: DocSection[];
}

export interface RenderResult {
  ok: boolean;
  /** Human-readable reason when ok=false (feeds the loop's failure behavior). */
  error?: string;
  /** The rendered file, when ok=true. */
  bytes?: Uint8Array;
  filename?: string;
  contentType?: string;
}

/** Deterministic validation — not an LLM judgment call. */
function validateDocumentContent(raw: unknown): { ok: true; content: DocumentContent } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "content is not an object" };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.title !== "string" || !obj.title.trim()) {
    return { ok: false, error: "title must be a non-empty string" };
  }
  if (!Array.isArray(obj.sections) || obj.sections.length === 0) {
    return { ok: false, error: "sections must be a non-empty array" };
  }
  const sections: DocSection[] = [];
  for (const s of obj.sections.slice(0, 25)) {
    if (!s || typeof s !== "object") return { ok: false, error: "section is not an object" };
    const so = s as Record<string, unknown>;
    if (typeof so.heading !== "string" || !so.heading.trim()) {
      return { ok: false, error: "section.heading must be a non-empty string" };
    }
    const paras = so.paragraphs;
    if (!Array.isArray(paras) || paras.length === 0 ||
        !paras.every((p) => typeof p === "string" && p.trim())) {
      return { ok: false, error: "section.paragraphs must be a non-empty array of strings" };
    }
    sections.push({
      heading: so.heading.trim().slice(0, 200),
      paragraphs: (paras as string[]).slice(0, 40).map((p) => p.trim().slice(0, 4000)),
    });
  }
  return { ok: true, content: { title: obj.title.trim().slice(0, 200), sections } };
}

/** Sanitize a title into a safe download filename. */
function safeFilename(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "document"}.docx`;
}

/**
 * Render a typed document content object into a real .docx file.
 * Deterministic: same input, same bytes. Throws nothing — returns ok:false
 * with a reason the loop can surface in plain language.
 */
export async function renderDocument(raw: unknown): Promise<RenderResult> {
  const v = validateDocumentContent(raw);
  if (!v.ok) return { ok: false, error: v.error };

  const { title, sections } = v.content;
  const children: Paragraph[] = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
  ];
  for (const s of sections) {
    children.push(new Paragraph({ text: s.heading, heading: HeadingLevel.HEADING_1 }));
    for (const p of s.paragraphs) {
      children.push(new Paragraph({ children: [new TextRun(p)] }));
    }
  }

  const doc = new Document({
    creator: "BeeZilla",
    title,
    sections: [{ children }],
  });

  try {
    const bytes = await Packer.toBuffer(doc);
    return {
      ok: true,
      bytes: new Uint8Array(bytes),
      filename: safeFilename(title),
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
  } catch (err) {
    return {
      ok: false,
      error: `renderer failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** JSON schema for the render_document tool (passed to chatCompletionFull). */
export const RENDER_DOCUMENT_TOOL = {
  type: "function",
  function: {
    name: "render_document",
    description:
      "Render the finished document the owner asked for as a real Word file. " +
      "Call this ONLY when the full deliverable is ready and the owner has asked for it. " +
      "Provide the complete document content — never placeholders or summaries. " +
      "Content must be an object: { title: string, sections: [{ heading: string, paragraphs: string[] }] } " +
      "with 1-25 sections, each with 1-40 non-empty paragraphs.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "The document's title, shown as the main heading and the filename." },
        sections: {
          type: "array",
          description: "The document body, in order.",
          items: {
            type: "object",
            properties: {
              heading: { type: "string", description: "Section heading." },
              paragraphs: { type: "array", items: { type: "string" }, description: "Full paragraphs of body text." },
            },
            required: ["heading", "paragraphs"],
          },
        },
      },
      required: ["title", "sections"],
    },
  },
};

/** Extract the typed content object from a tool call's arguments string. */
export function parseToolArguments(argumentsJson: string): unknown {
  let s = argumentsJson.trim();
  // Strip code fences if the model wrapped the JSON despite instructions.
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  return JSON.parse(s);
}

// ── Phase 2: presentation + spreadsheet renderers (plan doc 23) ─────────
// Same rule as render_document: model emits typed content, this module
// renders deterministically. Slide-count budget and sheet arithmetic are
// enforced HERE, not by the model.

import PptxGenJS from "pptxgenjs";
import ExcelJS from "exceljs";

export interface SlideContent {
  title: string;
  bullets: string[];
  notes?: string;
}

export interface PresentationContent {
  slides: SlideContent[];
}

export interface SheetRow {
  label: string;
  amount: number;
  /** Optional quantity — amount becomes unit price when quantity is present. */
  quantity?: number;
}

export interface SheetContent {
  title: string;
  rows: SheetRow[];
  /** Tax rate as a decimal fraction (e.g. 0.07). Applied by the renderer. */
  taxRate?: number;
}

/**
 * Render typed slides into a real .pptx. Deterministic.
 * Slide budget: 1–30 (the tool description tells the model the owner's stated
 * length; the renderer hard-caps regardless).
 */
export async function renderPresentation(raw: unknown): Promise<RenderResult> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "content is not an object" };
  }
  const obj = raw as Record<string, unknown>;
  const slidesRaw = obj.slides;
  if (!Array.isArray(slidesRaw) || slidesRaw.length === 0) {
    return { ok: false, error: "slides must be a non-empty array" };
  }
  if (slidesRaw.length > 30) {
    return { ok: false, error: `slide-count budget exceeded (${slidesRaw.length} > 30)` };
  }
  const slides: SlideContent[] = [];
  for (const s of slidesRaw) {
    if (!s || typeof s !== "object") return { ok: false, error: "slide is not an object" };
    const so = s as Record<string, unknown>;
    if (typeof so.title !== "string" || !so.title.trim()) {
      return { ok: false, error: "slide.title must be a non-empty string" };
    }
    if (!Array.isArray(so.bullets) || !so.bullets.every((b) => typeof b === "string" && b.trim())) {
      return { ok: false, error: "slide.bullets must be an array of non-empty strings" };
    }
    slides.push({
      title: so.title.trim().slice(0, 150),
      bullets: (so.bullets as string[]).slice(0, 10).map((b) => b.trim().slice(0, 300)),
      notes: typeof so.notes === "string" ? so.notes.slice(0, 1000) : undefined,
    });
  }
  try {
    const pptx = new PptxGenJS();
    pptx.title = (typeof obj.title === "string" ? obj.title : slides[0].title).slice(0, 150);
    for (const s of slides) {
      const slide = pptx.addSlide();
      slide.addText(s.title, { x: 0.5, y: 0.4, w: 9, h: 0.9, fontSize: 28, bold: true });
      slide.addText(s.bullets.map((b) => ({ text: b, options: { bullet: true } })), {
        x: 0.8, y: 1.5, w: 8.4, h: 4.5, fontSize: 18,
      });
      if (s.notes) slide.addNotes(s.notes);
    }
    const bytes = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
    const title = (typeof obj.title === "string" && obj.title.trim()) || slides[0].title;
    return {
      ok: true,
      bytes: new Uint8Array(bytes),
      filename: safeFilename(title).replace(/\.docx$/, ".pptx"),
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    };
  } catch (err) {
    return { ok: false, error: `renderer failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Render typed rows into a real .xlsx invoice/sheet. Deterministic.
 * ARITHMETIC IS RENDERER-SIDE: subtotals, tax, and the grand total are
 * computed here from the validated rows — the model never does the math.
 */
export async function renderSheet(raw: unknown): Promise<RenderResult> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "content is not an object" };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.title !== "string" || !obj.title.trim()) {
    return { ok: false, error: "title must be a non-empty string" };
  }
  if (!Array.isArray(obj.rows) || obj.rows.length === 0) {
    return { ok: false, error: "rows must be a non-empty array" };
  }
  const rows: SheetRow[] = [];
  for (const r of obj.rows.slice(0, 60)) {
    if (!r || typeof r !== "object") return { ok: false, error: "row is not an object" };
    const ro = r as Record<string, unknown>;
    if (typeof ro.label !== "string" || !ro.label.trim()) {
      return { ok: false, error: "row.label must be a non-empty string" };
    }
    if (typeof ro.amount !== "number" || !Number.isFinite(ro.amount) || ro.amount < 0) {
      return { ok: false, error: "row.amount must be a non-negative number" };
    }
    rows.push({
      label: ro.label.trim().slice(0, 150),
      amount: Math.round(ro.amount * 100) / 100,
      quantity: typeof ro.quantity === "number" && ro.quantity > 0 ? ro.quantity : undefined,
    });
  }
  let taxRate = 0;
  if (obj.taxRate !== undefined) {
    if (typeof obj.taxRate !== "number" || obj.taxRate < 0 || obj.taxRate > 0.3) {
      return { ok: false, error: "taxRate must be a number between 0 and 0.3" };
    }
    taxRate = obj.taxRate;
  }

  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(obj.title.trim().slice(0, 30));
    ws.columns = [
      { header: "Item", key: "label", width: 42 },
      { header: "Qty", key: "quantity", width: 8 },
      { header: "Amount", key: "amount", width: 14 },
    ];
    let subtotal = 0;
    for (const r of rows) {
      const line = r.quantity ? Math.round(r.amount * r.quantity * 100) / 100 : r.amount;
      subtotal += line;
      ws.addRow({ label: r.label, quantity: r.quantity ?? "", amount: line });
    }
    subtotal = Math.round(subtotal * 100) / 100;
    const tax = Math.round(subtotal * taxRate * 100) / 100;
    const total = Math.round((subtotal + tax) * 100) / 100;
    ws.addRow({});
    ws.addRow({ label: "Subtotal", amount: subtotal });
    if (taxRate > 0) {
      ws.addRow({ label: `Tax (${(taxRate * 100).toFixed(1)}%)`, amount: tax });
    }
    const totalRow = ws.addRow({ label: "Total", amount: total });
    totalRow.font = { bold: true };
    const bytes = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
    return {
      ok: true,
      bytes: new Uint8Array(bytes),
      filename: safeFilename(obj.title).replace(/\.docx$/, ".xlsx"),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    };
  } catch (err) {
    return { ok: false, error: `renderer failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** JSON schema for the render_presentation tool. */
export const RENDER_PRESENTATION_TOOL = {
  type: "function",
  function: {
    name: "render_presentation",
    description:
      "Render a slide presentation as a real PowerPoint file. Provide the COMPLETE " +
      "content — never placeholders. Content: { title: string, slides: [{ title: string, " +
      "bullets: string[], notes?: string }] }. Hard cap: 30 slides; respect any slide count " +
      "the owner stated.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Presentation title (also the filename)." },
        slides: {
          type: "array",
          description: "Slides in order.",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              bullets: { type: "array", items: { type: "string" } },
              notes: { type: "string", description: "Speaker notes (optional)." },
            },
            required: ["title", "bullets"],
          },
        },
      },
      required: ["title", "slides"],
    },
  },
};

/** JSON schema for the render_sheet tool (invoices, budgets, quotes). */
export const RENDER_SHEET_TOOL = {
  type: "function",
  function: {
    name: "render_sheet",
    description:
      "Render a spreadsheet (invoice, quote, budget) as a real Excel file. You provide " +
      "line items ONLY — the renderer computes subtotals, tax, and the grand total. Never " +
      "add a row for the total. Content: { title: string, rows: [{ label: string, " +
      "amount: number, quantity?: number }], taxRate?: number (decimal fraction, only if " +
      "the owner stated a tax rate). Every amount must come from the owner or confirmed " +
      "company facts — never invented.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Sheet title (also the filename)." },
        rows: {
          type: "array",
          description: "Line items.",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              amount: { type: "number", description: "Unit price, or the line amount when no quantity." },
              quantity: { type: "number", description: "Optional quantity." },
            },
            required: ["label", "amount"],
          },
        },
        taxRate: { type: "number", description: "Optional decimal tax rate (0.07 = 7%)." },
      },
      required: ["title", "rows"],
    },
  },
};

/** ── Money safety layer + multi-step review (approval-time checks) ────── */

export interface ReviewCheck {
  label: string;
  verdict: "verified" | "stated" | "warning";
  detail?: string;
}

/**
 * The "I checked" verdict computed at approval time — deterministic checks,
 * never model self-report. Rendered as civilian lines on the approval card.
 */
export function reviewDraft(draftText: string, ownerText: string): ReviewCheck[] {
  const checks: ReviewCheck[] = [];
  const moneyPattern = /\$\s?[0-9][0-9,]*(?:\.[0-9]{2})?|[0-9][0-9,]*(?:\.[0-9]{2})?\s?(?:dollars|usd)/gi;
  const draftAmounts = draftText.match(moneyPattern) ?? [];
  const ownerAmounts = new Set((ownerText.match(moneyPattern) ?? []).map(normMoney));
  const invented = draftAmounts.filter((a) => !ownerAmounts.has(normMoney(a)));
  checks.push({
    label: "Money",
    verdict: draftAmounts.length === 0 ? "stated" : invented.length === 0 ? "verified" : "warning",
    detail:
      draftAmounts.length === 0
        ? "No amounts in this draft."
        : invented.length === 0
          ? "All amounts came from you."
          : `These amounts did not come from you: ${[...new Set(invented)].slice(0, 3).join(", ")}. Check them.`,
  });
  const promises = /\b(guarantee|guaranteed|promise|24\/7|lifetime|always|never fail)\b/i.test(draftText);
  checks.push({
    label: "Promises",
    verdict: promises ? "warning" : "verified",
    detail: promises
      ? "Contains strong commitment words (guarantee/promise/always). Make sure you meant them."
      : "No strong commitments added.",
  });
  const incomplete = /\[[^\]]{1,60}\]|\bTBD\b|\bXXX\b/i.test(draftText);
  checks.push({
    label: "Completeness",
    verdict: incomplete ? "warning" : "verified",
    detail: incomplete
      ? "Still has [placeholders] — fill them before sending."
      : "No unfilled placeholders found.",
  });
  return checks;
}

function normMoney(s: string): string {
  return s.replace(/[\$,\s]/g, "").toLowerCase();
}
