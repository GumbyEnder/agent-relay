/**
 * BZ-F020 — minimal deterministic PDF renderer (no external dependency).
 *
 * One built-in Helvetica face, A4, 12pt/14.4pt leading, ~50 lines per page,
 * plus a Courier table mode at 9pt for fixed-width rows (CR-9 phase C: a memo
 * whose stress table re-flows into unaligned soup is not a memo a lender can
 * read, and a table rendered at 12pt costs a page it does not need).
 * Text streams are UNCOMPRESSED so the output is inspectable and testable
 * (QA-12: an export must contain exactly the chosen version's text).
 * This is a readable business PDF, not a layout engine — no fidelity claims.
 *
 * PAGE COUNT IS A FACT, NOT A GUESS. `renderTextPdfDocument` returns the page
 * count it actually produced, so CR-9 check C39 reads the renderer's number.
 * The renderer re-flows and never truncates: a body that needs three pages
 * produces three pages and says so. A truncated page 3 that "passes" a limit
 * check is the one outcome this file refuses to ship.
 */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 56;
const FONT_SIZE = 12;
const LEADING = 14.4;
const HEADING_SIZE = 14;
const HEADING_LEADING = 22.4;
const TITLE_SIZE = 16;
const TITLE_LEADING = 25.6;
const TABLE_SIZE = 9;
const TABLE_LEADING = 11.5;
/** Usable vertical space between margins; pagination counts height, not lines. */
const BODY_HEIGHT = PAGE_H - 2 * MARGIN;
const MAX_CHARS = 88; // rough Helvetica 12pt line width on A4 with margins
const TABLE_MAX_CHARS = 88; // Courier 9pt fits ~89 characters across the margins
const TABLE_GAP = 2;

export interface RenderedPdf {
  bytes: Uint8Array;
  /** Pages the renderer produced. C39 reads this, never a model's claim. */
  pageCount: number;
  /** true when maxPages was given and pageCount <= maxPages; null when not asked. */
  withinLimit: boolean | null;
}

export interface PdfRenderOptions {
  /** Render markdown pipe tables in fixed-width Courier columns. Default true. */
  tables?: boolean;
  /** Page budget, reported as `withinLimit`. The renderer never truncates. */
  maxPages?: number;
}

function escapePdfText(s: string): string {
  // Latin-1 safe: replace characters outside WinAnsi with their closest mark.
  return s
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function wrapLine(line: string): string[] {
  if (line.length <= MAX_CHARS) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > MAX_CHARS) {
    let cut = rest.lastIndexOf(" ", MAX_CHARS);
    if (cut < MAX_CHARS * 0.5) cut = MAX_CHARS;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

type Font = "F1" | "F2";

interface PdfLine {
  text: string;
  size: number;
  font: Font;
  height: number;
}

const isTableRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line);
const isTableSeparator = (line: string): boolean =>
  isTableRow(line) &&
  line
    .trim()
    .slice(1, -1)
    .split("|")
    .every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));

function tableCells(line: string): string[] {
  return line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim().replace(/[*`]/g, ""));
}

/** Fit cells into TABLE_MAX_CHARS: natural widths first, then proportional clip. */
function layoutTable(rows: string[][]): string[] {
  const cols = rows.reduce((n, row) => Math.max(n, row.length), 0);
  const widths: number[] = new Array(cols).fill(0);
  for (const row of rows) {
    for (let c = 0; c < cols; c++) widths[c] = Math.max(widths[c]!, (row[c] ?? "").length);
  }
  const gaps = TABLE_GAP * Math.max(0, cols - 1);
  const natural = widths.reduce((a, b) => a + b, 0) + gaps;
  if (natural > TABLE_MAX_CHARS) {
    // Shrink the widest columns first, floor at 6 characters: a numeric column
    // clipped to three digits silently changes the number, which is worse than
    // a cramped table.
    let over = natural - TABLE_MAX_CHARS;
    while (over > 0) {
      let widest = 0;
      for (let c = 1; c < cols; c++) if (widths[c]! > widths[widest]!) widest = c;
      if (widths[widest]! <= 6) break;
      widths[widest]! -= 1;
      over -= 1;
    }
  }
  const pad = (cell: string, width: number): string => {
    const text = cell.length <= width ? cell : cell.slice(0, Math.max(1, width - 2)) + "..";
    return text.padEnd(width, " ");
  };
  return rows.map((row) => {
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) cells.push(pad(row[c] ?? "", widths[c]!));
    return cells.join(" ".repeat(TABLE_GAP)).trimEnd();
  });
}

/** Walk the body, turning markdown pipe tables into fixed-width blocks. */
function bodyLines(body: string, tables: boolean): PdfLine[] {
  const out: PdfLine[] = [];
  const raw = body.split("\n");
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]!;
    if (tables && isTableRow(line)) {
      const rows: string[][] = [];
      let j = i;
      let headerSeen = false;
      while (j < raw.length && isTableRow(raw[j]!)) {
        if (isTableSeparator(raw[j]!)) {
          j++;
          continue;
        }
        rows.push(tableCells(raw[j]!));
        headerSeen = true;
        j++;
      }
      if (headerSeen && rows.length) {
        for (const text of layoutTable(rows)) {
          out.push({ text, size: TABLE_SIZE, font: "F2", height: TABLE_LEADING });
        }
        i = j - 1;
        continue;
      }
    }
    const heading = line.match(/^#{1,3}\s+(.*)$/);
    if (heading) {
      out.push({ text: heading[1]!, size: HEADING_SIZE, font: "F1", height: HEADING_LEADING });
      continue;
    }
    for (const wrapped of wrapLine(line)) {
      out.push({ text: wrapped, size: FONT_SIZE, font: "F1", height: LEADING });
    }
  }
  return out;
}

/**
 * Render a body and report how many pages it actually took.
 * Deterministic: same input, same bytes, same page count.
 */
export function renderTextPdfDocument(
  title: string,
  body: string,
  options: PdfRenderOptions = {},
): RenderedPdf {
  const lines: PdfLine[] = [
    { text: title, size: TITLE_SIZE, font: "F1", height: TITLE_LEADING },
    { text: "", size: FONT_SIZE, font: "F1", height: LEADING },
    ...bodyLines(body, options.tables !== false),
  ];

  const pages: PdfLine[][] = [];
  let current: PdfLine[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.height > BODY_HEIGHT && current.length) {
      pages.push(current);
      current = [];
      used = 0;
    }
    current.push(line);
    used += line.height;
  }
  if (current.length) pages.push(current);
  if (!pages.length) pages.push([{ text: "(empty)", size: FONT_SIZE, font: "F1", height: LEADING }]);

  // Object assembly: 1 catalog, 2 pages tree, 3 Helvetica, 4 Courier,
  // then per page: content + page.
  const objects: string[] = [];
  const pageObjIds: number[] = [];
  const contentObjIds: number[] = [];
  for (let i = 0; i < pages.length; i++) {
    contentObjIds.push(5 + i * 2);
    pageObjIds.push(6 + i * 2);
  }

  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>";

  pages.forEach((pageLines, i) => {
    const ops: string[] = ["BT"];
    let y = PAGE_H - MARGIN;
    let prevKey = "";
    for (const line of pageLines) {
      const key = `${line.font} ${line.size}`;
      if (key !== prevKey) {
        ops.push(`/${line.font} ${line.size} Tf`);
        prevKey = key;
      }
      ops.push(`1 0 0 1 ${MARGIN} ${y.toFixed(2)} Tm (${escapePdfText(line.text)}) Tj`);
      y -= line.height;
    }
    ops.push("ET");
    const stream = ops.join("\n");
    objects[contentObjIds[i]! - 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    objects[pageObjIds[i]! - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjIds[i]} 0 R >>`;
  });

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return {
    bytes: new Uint8Array(Buffer.from(pdf, "latin1")),
    pageCount: pages.length,
    withinLimit:
      typeof options.maxPages === "number" ? pages.length <= options.maxPages : null,
  };
}

/** Render plain text (markdown-ish headings become larger lines). */
export function renderTextPdf(title: string, body: string): Uint8Array {
  return renderTextPdfDocument(title, body).bytes;
}
