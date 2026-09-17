/**
 * BeeZilla — SOW (Scope of Work) formatter
 *
 * Reads the dana-template.md placeholders and fills them from structured
 * answers, producing markdown or a minimal PDF.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SowAnswers {
  clientName: string;
  propertyAddress: string;
  date: string;
  whatTheyWant: string;
  whyNow: string;
  propertyDetails: string;
  householdDetails: string;
  stylePreference: string;
  heightAndLook: string;
  gates: string;
  timeline: string;
  budgetRange: string;
  propertyLineNotes: string;
  groundConditions: string;
  obstacles: string;
  utilityLocateStatus: string;
  existingFenceStatus: string;
  photoReferences: string;
  doneCriterion1: string;
  doneCriterion2: string;
  doneCriterion3: string;
  doneCriterion4: string;
  doneCriterion5: string;
  walkthroughArrangement: string;
  exclusion1: string;
  exclusion2: string;
  exclusion3: string;
  exclusion4: string;
  exclusion5: string;
  permitResponsibility: string;
  item1: string;
  item1Desc: string;
  item1Qty: string;
  item1Unit: string;
  item1Total: string;
  item2: string;
  item2Desc: string;
  item2Qty: string;
  item2Unit: string;
  item2Total: string;
  item3: string;
  item3Desc: string;
  item3Qty: string;
  item3Unit: string;
  item3Total: string;
  haulDesc: string;
  haulQty: string;
  haulUnit: string;
  haulTotal: string;
  subtotal: string;
  tax: string;
  total: string;
  paymentTerms: string;
  estimatedStart: string;
  estimatedDuration: string;
  postDepth: string;
}

// ---------------------------------------------------------------------------
// fillTemplate — replace {{PLACEHOLDER}} tokens with answer values
// ---------------------------------------------------------------------------

const PLACEHOLDER_MAP: Record<keyof SowAnswers, string> = {
  clientName: "CLIENT_NAME",
  propertyAddress: "PROPERTY_ADDRESS",
  date: "DATE",
  whatTheyWant: "WHAT_THEY_WANT",
  whyNow: "WHY_NOW",
  propertyDetails: "PROPERTY_DETAILS",
  householdDetails: "HOUSEHOLD_DETAILS",
  stylePreference: "STYLE_PREFERENCE",
  heightAndLook: "HEIGHT_AND_LOOK",
  gates: "GATES",
  timeline: "TIMELINE",
  budgetRange: "BUDGET_RANGE",
  propertyLineNotes: "PROPERTY_LINE_NOTES",
  groundConditions: "GROUND_CONDITIONS",
  obstacles: "OBSTACLES",
  utilityLocateStatus: "UTILITY_LOCATE_STATUS",
  existingFenceStatus: "EXISTING_FENCE_STATUS",
  photoReferences: "PHOTO_REFERENCES",
  doneCriterion1: "DONE_CRITERION_1",
  doneCriterion2: "DONE_CRITERION_2",
  doneCriterion3: "DONE_CRITERION_3",
  doneCriterion4: "DONE_CRITERION_4",
  doneCriterion5: "DONE_CRITERION_5",
  walkthroughArrangement: "WALKTHROUGH_ARRANGEMENT",
  exclusion1: "EXCLUSION_1",
  exclusion2: "EXCLUSION_2",
  exclusion3: "EXCLUSION_3",
  exclusion4: "EXCLUSION_4",
  exclusion5: "EXCLUSION_5",
  permitResponsibility: "PERMIT_RESPONSIBILITY",
  item1: "ITEM_1",
  item1Desc: "ITEM_1_DESC",
  item1Qty: "ITEM_1_QTY",
  item1Unit: "ITEM_1_UNIT",
  item1Total: "ITEM_1_TOTAL",
  item2: "ITEM_2",
  item2Desc: "ITEM_2_DESC",
  item2Qty: "ITEM_2_QTY",
  item2Unit: "ITEM_2_UNIT",
  item2Total: "ITEM_2_TOTAL",
  item3: "ITEM_3",
  item3Desc: "ITEM_3_DESC",
  item3Qty: "ITEM_3_QTY",
  item3Unit: "ITEM_3_UNIT",
  item3Total: "ITEM_3_TOTAL",
  haulDesc: "HAUL_DESC",
  haulQty: "HAUL_QTY",
  haulUnit: "HAUL_UNIT",
  haulTotal: "HAUL_TOTAL",
  subtotal: "SUBTOTAL",
  tax: "TAX",
  total: "TOTAL",
  paymentTerms: "PAYMENT_TERMS",
  estimatedStart: "ESTIMATED_START",
  estimatedDuration: "ESTIMATED_DURATION",
  postDepth: "POST_DEPTH",
};

/**
 * Read the template and replace every {{KEY}} placeholder with the
 * corresponding value from `answers`.
 */
export function fillTemplate(answers: SowAnswers): string {
  const templatePath = resolve(
    __dirname,
    "..",
    "sow",
    "dana-template.md",
  );
  let text = readFileSync(templatePath, "utf-8");

  for (const [key, placeholder] of Object.entries(PLACEHOLDER_MAP)) {
    const value = answers[key as keyof SowAnswers] ?? "";
    text = text.replaceAll(`{{${placeholder}}}`, value);
  }

  return text;
}

// ---------------------------------------------------------------------------
// toMarkdown — convenience wrapper
// ---------------------------------------------------------------------------

/**
 * Produce a markdown SOW string from answers.
 */
export function toMarkdown(answers: SowAnswers): string {
  return fillTemplate(answers);
}

// ---------------------------------------------------------------------------
// toPdf — minimal PDF writer (no external dependencies)
// ---------------------------------------------------------------------------

/**
 * Encode a string as PDF text (escape backslashes, parens, and
 * convert newlines to \n).
 */
function pdfTextEncode(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, "\\n");
}

/**
 * Convert markdown text to a simple multi-page PDF with monospaced text
 * rendered line-by-line.  No fonts, no images — just a stream of text
 * objects.
 */
export function toPdf(answers: SowAnswers): Uint8Array {
  const markdown = fillTemplate(answers);
  const lines = markdown.split("\n");

  // -----------------------------------------------------------------------
  // Paginate lines across pages
  // -----------------------------------------------------------------------
  const fontSize = 11;
  const lineHeight = fontSize * 1.4;
  const pageTop = 750;
  const pageBottom = 50;
  const margin = 50;
  const linesPerPage = Math.floor((pageTop - pageBottom) / lineHeight);

  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage));
  }

  const pageCount = pages.length;

  // -----------------------------------------------------------------------
  // Build all objects
  // -----------------------------------------------------------------------
  const parts: string[] = [];
  let offset = 0;
  const offsets: number[] = [];

  // Helper: emit an object and record its offset
  function emitObj(num: number, content: string): number {
    offsets.push(offset);
    const header = `${num} 0 obj\n`;
    const footer = `\nendobj\n`;
    const block = header + content + footer;
    parts.push(block);
    offset += header.length + content.length + footer.length;
    return offset;
  }

  // 1: PDF header
  parts.push("%PDF-1.4\n");
  offset += 8;

  // 2: Catalog
  emitObj(1, `<< /Type /Catalog /Pages 2 0 R >>`);

  // Build page content streams
  const contentStreams: string[] = [];
  for (const pageLines of pages) {
    let streamContent = "";
    let y = pageTop;
    for (const line of pageLines) {
      const encoded = pdfTextEncode(line);
      streamContent += `BT /F1 ${fontSize} Tf ${margin} ${y} Td (${encoded}) Tj ET\n`;
      y -= lineHeight;
    }
    contentStreams.push(streamContent);
  }

  // 3: Pages object (kids reference all page objects)
  const kidsRefs = pages
    .map((_, i) => `${3 + i} 0 R`)
    .join(" ");
  emitObj(2, `<< /Type /Pages /Kids [${kidsRefs}] /Count ${pageCount} >>`);

  // 4..N+3: Page objects and content streams
  for (let i = 0; i < pageCount; i++) {
    const pageNum = 3 + i;
    const contentNum = pageNum + pageCount;
    const parentRef = i === 0 ? "2 0 R" : "2 0 R";
    emitObj(
      pageNum,
      `<< /Type /Page /Parent ${parentRef} /MediaBox [0 0 612 792] /Contents ${contentNum} 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    );
  }

  // Content streams
  for (let i = 0; i < pageCount; i++) {
    const streamLen = contentStreams[i].length;
    emitObj(
      3 + pageCount + i,
      `<< /Length ${streamLen} >>\nstream\n${contentStreams[i]}endstream`,
    );
  }

  // Font dictionary
  emitObj(
    5,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
  );

  // xref
  const xrefOffset = offset;
  const objectCount = 6 + pageCount * 2; // catalog + pages + pages + contents + font + xref/trailer
  offsets.push(offset);
  let xref = `xref\n0 ${objectCount}\n`;
  xref += `0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  parts.push(xref);
  offset += xref.length;

  // trailer
  const trailer = `trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  parts.push(trailer);

  // Build final buffer
  const full = parts.join("");
  const encoder = new TextEncoder();
  return encoder.encode(full);
}
