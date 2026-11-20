/**
 * CR-9 phase C — outputs.
 *
 * The memo leaves the product as four files that all say the same thing:
 * Markdown (the canonical text stored in `buzzy_documents`), PDF (a two-page
 * credit memo), DOCX (the lender's edit surface) and CSV (the stress table as
 * a spreadsheet). Nothing here invents a number: the text arrives already
 * computed, and this module only turns it into bytes.
 *
 * WHY A WRITER AND NOT A LIBRARY. `cre/csv.ts` reads quoted fields, CRLF and a
 * BOM because the user's spreadsheets contain commas inside names. The writer
 * has to survive the same inputs on the way out, so quoting is RFC 4180 and
 * every value is a string that was in the cell — no locale, no date guessing.
 *
 * PAGE COUNT IS THE RENDERER'S NUMBER. `renderDealMemo` takes the PDF's
 * `pageCount` and refuses a body that overruns the budget with the named code
 * `C39_PAGE_LIMIT`. Check C39 in phase D reads the same number, so the check
 * and the file cannot disagree.
 */

import {
  renderTextPdfDocument,
  type RenderedPdf,
} from "../pdf";
import { renderDocument, type DocSection, type DocumentContent } from "../artifact";
import type { StressTable } from "./stress";

export const MEMO_MAX_PAGES = 2;

// ── CSV writer ─────────────────────────────────────────────────────────

/** RFC 4180 cell: quote when the value contains a comma, quote or newline. */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Deterministic CSV text; LF line endings, trailing newline, no BOM. */
export function writeCsv(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return lines.join("\n") + "\n";
}

// ── Markdown tables ────────────────────────────────────────────────────

export interface MarkdownTable {
  headers: string[];
  rows: string[][];
  /** 1-based line in the markdown where the header sits (a locator). */
  line: number;
}

const tableRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line);
const tableSeparator = (line: string): boolean =>
  tableRow(line) &&
  line
    .trim()
    .slice(1, -1)
    .split("|")
    .every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));

function cellsOf(line: string): string[] {
  return line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

/** Every pipe table in the document, in document order. */
export function markdownTables(markdown: string): MarkdownTable[] {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const tables: MarkdownTable[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!tableRow(lines[i]!) || tableSeparator(lines[i]!)) continue;
    const headers = cellsOf(lines[i]!);
    const rows: string[][] = [];
    let j = i + 1;
    let separated = false;
    while (j < lines.length && tableRow(lines[j]!)) {
      if (tableSeparator(lines[j]!)) {
        separated = true;
        j++;
        continue;
      }
      rows.push(cellsOf(lines[j]!));
      j++;
    }
    // A pipe row without its separator line is prose that happens to contain
    // pipes, not a table. Exporting it as CSV would be a silent fiction.
    if (separated) tables.push({ headers, rows, line: i + 1 });
    i = j - 1;
  }
  return tables;
}

/**
 * All tables as one CSV, separated by a blank line. Null when the document has
 * no real table — callers must say "no table to export", never emit an empty
 * file (the existing export route's `no_table` behaviour).
 */
export function markdownTableToCsv(markdown: string): string | null {
  const tables = markdownTables(markdown);
  if (!tables.length) return null;
  return (
    tables
      .map((t) => writeCsv(t.headers, t.rows).trimEnd())
      .join("\n\n") + "\n"
  );
}

// ── Markdown -> the typed document shape ───────────────────────────────

const MAX_SECTIONS = 25;
const MAX_PARAGRAPHS = 40;
const MAX_PARAGRAPH_CHARS = 4000;

/**
 * Turn the memo's markdown into `render_document`'s typed content.
 *
 * Table rows become fixed-width text lines rather than being dropped: a Word
 * file without the stress table is not the memo. Headings become sections; a
 * section longer than the renderer's paragraph cap is split into a numbered
 * continuation instead of being silently truncated.
 */
export function documentContentFromMarkdown(
  markdown: string,
  fallbackTitle = "Document",
): { ok: true; content: DocumentContent } | { ok: false; error: string } {
  const text = String(markdown ?? "").replace(/\r\n?/g, "\n");
  let title = fallbackTitle;
  const sections: DocSection[] = [];
  let heading = "";
  let paragraphs: string[] = [];
  let sawTitle = false;

  const flush = () => {
    if (!heading && !paragraphs.length) return;
    sections.push({ heading: heading || title, paragraphs: paragraphs.length ? paragraphs : ["(no text)"] });
    paragraphs = [];
  };

  for (const raw of text.split("\n")) {
    const h1 = raw.match(/^#\s+(.*)$/);
    if (h1 && !sawTitle) {
      title = h1[1]!.trim().slice(0, 200) || title;
      sawTitle = true;
      continue;
    }
    const h = raw.match(/^#{2,3}\s+(.*)$/);
    if (h) {
      flush();
      heading = h[1]!.trim().slice(0, 200);
      continue;
    }
    if (tableRow(raw)) {
      if (tableSeparator(raw)) continue;
      paragraphs.push(cellsOf(raw).join("  |  ").slice(0, MAX_PARAGRAPH_CHARS));
      continue;
    }
    const line = raw.trim();
    if (!line) continue;
    paragraphs.push(line.slice(0, MAX_PARAGRAPH_CHARS));
  }
  flush();
  if (!sections.length) return { ok: false, error: "the document has no body text" };

  // Split any section past the renderer's caps rather than lose lines.
  const shaped: DocSection[] = [];
  for (const section of sections) {
    for (let i = 0; i < section.paragraphs.length; i += MAX_PARAGRAPHS) {
      const chunk = section.paragraphs.slice(i, i + MAX_PARAGRAPHS);
      const suffix = section.paragraphs.length > MAX_PARAGRAPHS ? ` (${i / MAX_PARAGRAPHS + 1})` : "";
      shaped.push({ heading: (section.heading + suffix).slice(0, 200), paragraphs: chunk });
    }
  }
  if (shaped.length > MAX_SECTIONS) {
    return {
      ok: false,
      error: `the document has ${shaped.length} sections; the renderer accepts ${MAX_SECTIONS}`,
    };
  }
  return { ok: true, content: { title, sections: shaped } };
}

// ── Stress table -> the fixture's CSV shape ────────────────────────────

const dollars = (cents: number): number => Math.round(cents / 100);
const pct = (basisPoints: number): string => (basisPoints / 100).toFixed(2);
const x = (x100: number): string => (x100 / 100).toFixed(2);

/**
 * The stress table in the shape of `fixtures/expected_stress_table.csv`, so the
 * spreadsheet a user downloads is the same table the acceptance fixture pins.
 */
export function stressTableToCsv(table: StressTable): string {
  return writeCsv(
    [
      "scenario",
      "note_rate_pct",
      "annual_debt_service_usd",
      "noi_usd",
      "dscr_x",
      "ltv_pct",
      "debt_yield_pct",
    ],
    table.rows.map((row) => [
      row.rateShiftBp === 0 ? "base" : `+${row.rateShiftBp}bp`,
      pct(row.noteRateBp),
      dollars(row.annualDebtServiceCents),
      dollars(row.noiCents),
      x(row.dscrX100),
      pct(row.ltvBp),
      pct(row.debtYieldBp),
    ]),
  );
}

// ── The whole set of files ─────────────────────────────────────────────

export interface MemoFiles {
  markdown: string;
  pdf: { bytes: Uint8Array; pageCount: number };
  docx: { bytes: Uint8Array; filename: string; contentType: string };
  csv: string | null;
}

export type MemoRenderResult =
  | {
      ok: true;
      files: MemoFiles;
      limits: { pageCount: number; maxPages: number };
    }
  | {
      ok: false;
      code: "C39_PAGE_LIMIT" | "EMPTY_MEMO" | "DOCX_FAILED";
      message: string;
      pageCount?: number;
      maxPages: number;
    };

/**
 * Render the memo's four files. Fails closed, by name, when the PDF overruns
 * the page budget: the caller must surface "the memo is 3 pages, the limit is
 * 2" and not hand over a truncated file.
 */
export async function renderDealMemo(input: {
  title: string;
  markdown: string;
  maxPages?: number;
}): Promise<MemoRenderResult> {
  const maxPages = input.maxPages ?? MEMO_MAX_PAGES;
  const markdown = String(input.markdown ?? "").trim();
  if (!markdown) {
    return { ok: false, code: "EMPTY_MEMO", message: "the memo is empty", maxPages };
  }

  const pdf: RenderedPdf = renderTextPdfDocument(input.title, markdown, { maxPages });
  if (!pdf.withinLimit) {
    return {
      ok: false,
      code: "C39_PAGE_LIMIT",
      message: `the memo renders to ${pdf.pageCount} pages; the limit is ${maxPages}`,
      pageCount: pdf.pageCount,
      maxPages,
    };
  }

  const shaped = documentContentFromMarkdown(markdown, input.title);
  if (!shaped.ok) {
    return { ok: false, code: "DOCX_FAILED", message: shaped.error, pageCount: pdf.pageCount, maxPages };
  }
  const rendered = await renderDocument(shaped.content);
  if (!rendered.ok || !rendered.bytes || !rendered.filename || !rendered.contentType) {
    return {
      ok: false,
      code: "DOCX_FAILED",
      message: rendered.error ?? "the Word render produced no file",
      pageCount: pdf.pageCount,
      maxPages,
    };
  }

  return {
    ok: true,
    files: {
      markdown: markdown + "\n",
      pdf: { bytes: pdf.bytes, pageCount: pdf.pageCount },
      docx: {
        bytes: rendered.bytes,
        filename: rendered.filename,
        contentType: rendered.contentType,
      },
      csv: markdownTableToCsv(markdown),
    },
    limits: { pageCount: pdf.pageCount, maxPages },
  };
}
