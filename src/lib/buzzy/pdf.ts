/**
 * BZ-F020 — minimal deterministic PDF renderer (no external dependency).
 *
 * One built-in Helvetica face, A4, 12pt/14.4pt leading, ~52 lines per page.
 * Text streams are UNCOMPRESSED so the output is inspectable and testable
 * (QA-12: an export must contain exactly the chosen version's text).
 * This is a readable business PDF, not a layout engine — no fidelity claims.
 */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 56;
const FONT_SIZE = 12;
const LEADING = 14.4;
const LINES_PER_PAGE = Math.floor((PAGE_H - 2 * MARGIN) / LEADING);
const MAX_CHARS = 88; // rough Helvetica 12pt line width on A4 with margins

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

/** Render plain text (markdown-ish headings become bold-ish larger lines). */
export function renderTextPdf(title: string, body: string): Uint8Array {
  const logicalLines: Array<{ text: string; size: number }> = [
    { text: title, size: 16 },
    { text: "", size: FONT_SIZE },
  ];
  for (const raw of body.split("\n")) {
    const heading = raw.match(/^#{1,3}\s+(.*)$/);
    if (heading) {
      logicalLines.push({ text: heading[1], size: 14 });
      continue;
    }
    for (const wrapped of wrapLine(raw)) {
      logicalLines.push({ text: wrapped, size: FONT_SIZE });
    }
  }

  // Paginate (heading lines count double-ish for the title size)
  const pages: Array<Array<{ text: string; size: number }>> = [];
  let current: Array<{ text: string; size: number }> = [];
  let used = 0;
  for (const line of logicalLines) {
    const cost = line.size >= 14 ? 2 : 1;
    if (used + cost > LINES_PER_PAGE && current.length) {
      pages.push(current);
      current = [];
      used = 0;
    }
    current.push(line);
    used += cost;
  }
  if (current.length) pages.push(current);
  if (!pages.length) pages.push([{ text: "(empty)", size: FONT_SIZE }]);

  // Object assembly: 1 catalog, 2 pages tree, 3 font, then per page: content + page
  const objects: string[] = [];
  const pageObjIds: number[] = [];
  const contentObjIds: number[] = [];
  for (let i = 0; i < pages.length; i++) {
    contentObjIds.push(4 + i * 2);
    pageObjIds.push(5 + i * 2);
  }

  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

  pages.forEach((lines, i) => {
    const ops: string[] = ["BT"];
    let y = PAGE_H - MARGIN;
    let prevSize = 0;
    for (const line of lines) {
      const size = line.size;
      if (size !== prevSize) {
        ops.push(`/F1 ${size} Tf`);
        prevSize = size;
      }
      ops.push(`1 0 0 1 ${MARGIN} ${y.toFixed(2)} Tm (${escapePdfText(line.text)}) Tj`);
      y -= size >= 14 ? LEADING * 1.6 : LEADING;
    }
    ops.push("ET");
    const stream = ops.join("\n");
    objects[contentObjIds[i] - 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    objects[pageObjIds[i] - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjIds[i]} 0 R >>`;
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
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}
