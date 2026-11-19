/**
 * CR-9 — a small CSV reader for the deal-memo inputs.
 *
 * The rent roll and the comps file are the user's own spreadsheets, so this has
 * to survive quoted fields with commas inside (Elm Portfolio, 3 bldgs), CRLF,
 * a UTF-8 BOM, and trailing blank lines. It is deliberately NOT a general CSV
 * library: no type coercion, no formula handling, no encoding guessing. Every
 * value comes back as the string that was in the cell; the parsers decide what
 * that string has to be.
 *
 * A malformed row does not silently disappear. It is returned in `problems`
 * with its 1-based line number so the caller can refuse the run or flag the
 * row. Silently dropping a tenant is the failure this function exists to avoid.
 */

export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
  /** 1-based file line of each row, parallel to `rows`. Locators for citations. */
  lines: number[];
  problems: { line: number; reason: string }[];
}

/** Split one CSV line into cells, honouring "quoted, fields" and "" escapes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  out.push(cell);
  return out;
}

/** Lower-case, trim, collapse inner runs of spaces/underscores to one underscore. */
export function normaliseHeader(name: string): string {
  return name
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function parseCsvTable(text: string): CsvTable {
  const problems: CsvTable["problems"] = [];
  const lines = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .split(/\r\n|\n|\r/);

  let headerLine = -1;
  let headers: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "") {
      headerLine = i;
      headers = splitCsvLine(lines[i]).map(normaliseHeader);
      break;
    }
  }
  if (headerLine === -1) return { headers: [], rows: [], lines: [], problems: [{ line: 1, reason: "empty_file" }] };

  const seen = new Set<string>();
  for (const h of headers) {
    if (h === "") {
      problems.push({ line: headerLine + 1, reason: "blank_header" });
    } else if (seen.has(h)) {
      problems.push({ line: headerLine + 1, reason: `duplicate_header:${h}` });
    }
    seen.add(h);
  }

  const rows: Record<string, string>[] = [];
  const rowLines: number[] = [];
  for (let i = headerLine + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const cells = splitCsvLine(line);
    if (cells.length !== headers.length) {
      // Short rows are the common spreadsheet export bug (a trailing empty cell
      // omitted). Pad missing cells, but record it — a missing rent column is
      // not the same as a rent of zero.
      problems.push({ line: i + 1, reason: `column_count:${cells.length}/${headers.length}` });
      if (cells.length > headers.length) continue;
    }
    rows.push({});
    rowLines.push(i + 1);
    const row = rows[rows.length - 1];
    for (let c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      row[headers[c]] = c < cells.length ? cells[c].trim() : "";
    }
  }

  return { headers, rows, lines: rowLines, problems };
}

/** Fields the caller cannot proceed without. Returns null when all are present. */
export function missingColumns(headers: string[], required: string[]): string[] | null {
  const have = new Set(headers.filter(Boolean));
  const missing = required.filter((c) => !have.has(c));
  return missing.length ? missing : null;
}
