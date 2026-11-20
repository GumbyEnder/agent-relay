/**
 * CR-9 — intake: what came in, bound to a role, hashed, and nothing leaked.
 *
 * The deal memo has six named inputs (spec §2). Each one has a role, and the
 * role is what decides whether the bytes are acceptable: a rent roll must be a
 * CSV or an XLSX and nothing else, a photo must be a JPEG or a PNG, a listing
 * may be a PDF or pasted text. Checking the extension alone is theatre — the
 * magic bytes decide, and `sniffKind` is the arbiter.
 *
 * THE LEDGER RULE. `toLedger()` is the only thing that may be logged, stored in
 * a job row, or put in an error message. It carries the role, the sha256, the
 * byte count and derived COUNTS — never the filename, never a tenant name, never
 * a line of the listing. A rent roll names tenants and rents; that is the most
 * sensitive document in the package, and a log line is the easiest place to
 * lose it. Anything that needs the text gets it from `readListing()` /
 * `readRentRoll()` in process, and the text dies with the turn.
 *
 * HEIC/TIFF photos are refused here, not stored: `bytes.ts` cannot prove their
 * metadata is gone, and storing a photo we did not scrub is worse than asking
 * for a JPEG.
 */

import ExcelJS from "exceljs";

import { sha256Hex, sniffKind, stripImageMetadata, type SniffedKind } from "./bytes";
import { parseRentRollCsv, type ParsedRentRoll } from "./rentRoll";
import { parseCompsCsv, type ParsedComps } from "./comps";

export type DealInputRole = "listing" | "rent_roll" | "comps" | "photos";

export interface RoleRule {
  label: string;
  extensions: string[];
  kinds: SniffedKind[];
  maxBytes: number;
  /** Hard cap on data rows for tabular inputs. */
  maxRows: number | null;
}

const MB = 1024 * 1024;

export const DEAL_ROLES: Record<DealInputRole, RoleRule> = {
  listing: {
    label: "listing",
    extensions: [".pdf", ".txt", ".md"],
    kinds: ["pdf", "text", "csv"],
    maxBytes: 20 * MB,
    maxRows: null,
  },
  rent_roll: {
    label: "rent roll",
    extensions: [".csv", ".xlsx"],
    kinds: ["csv", "text", "zip"],
    maxBytes: 5 * MB,
    maxRows: 500,
  },
  comps: {
    label: "comps",
    extensions: [".csv", ".xlsx"],
    kinds: ["csv", "text", "zip"],
    maxBytes: 5 * MB,
    maxRows: 200,
  },
  photos: {
    label: "photo",
    extensions: [".jpg", ".jpeg", ".png"],
    kinds: ["jpeg", "png"],
    maxBytes: 10 * MB,
    maxRows: null,
  },
};

export function isDealRole(value: unknown): value is DealInputRole {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(DEAL_ROLES, value);
}

function extensionOf(filename: string): string {
  const name = filename.trim().toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot);
}

export interface RoleInput {
  role: DealInputRole;
  filename: string;
  contentType?: string;
  bytes: Uint8Array;
}

export type BindResult =
  | { ok: true; role: DealInputRole; kind: SniffedKind; sha256: string }
  | { ok: false; role: DealInputRole; code: string; message: string };

/**
 * Accept or refuse one upload for one role. Refusals name the reason and the
 * limit — "photo: HEIC is not accepted, save it as JPEG" is actionable, "invalid
 * file" is not.
 */
export function bindRole(input: RoleInput): BindResult {
  const rule = DEAL_ROLES[input.role];
  const fail = (code: string, message: string): BindResult => ({ ok: false, role: input.role, code, message });

  if (!input.bytes || input.bytes.byteLength === 0) return fail("empty_file", `The ${rule.label} file is empty.`);
  if (input.bytes.byteLength > rule.maxBytes) {
    return fail(
      "file_too_large",
      `The ${rule.label} is ${(input.bytes.byteLength / MB).toFixed(1)} MB; the limit is ${rule.maxBytes / MB} MB.`,
    );
  }

  const ext = extensionOf(input.filename);
  if (!rule.extensions.includes(ext)) {
    return fail(
      "wrong_extension",
      `A ${rule.label} must be ${rule.extensions.join(", ")} — that file is ${ext || "unnamed"}.`,
    );
  }

  const kind = sniffKind(input.bytes);
  if (!rule.kinds.includes(kind)) {
    // The extension said one thing and the bytes said another: name both.
    return fail(
      "content_mismatch",
      `That ${rule.label} file is not readable as ${rule.extensions.join("/")} — its contents look like ${kind}.`,
    );
  }
  if (kind === "zip" && (ext === ".csv" || ext === ".xlsx") === false) {
    return fail("content_mismatch", `That ${rule.label} looks like a zip/office file; give it as .xlsx.`);
  }

  return { ok: true, role: input.role, kind, sha256: sha256Hex(input.bytes) };
}

// ── Duplicate uploads ───────────────────────────────────────────────

export type DuplicateDecision =
  | { ok: true; path: string; role: DealInputRole | null }
  | { ok: false; code: "role_conflict"; message: string };

/**
 * Content addressing is per account by sha256, so the same bytes can only have
 * one row. That is fine for a repeat upload of the same file, and WRONG when the
 * second upload asked for a role: the route would answer `ok: true` with a path
 * under the first upload's name, and the deal-memo runner would look for
 * `deals/<role>/…` and find nothing. Refuse instead of silently binding bytes to
 * a path they are not stored at. (Found by the signed-in HTTP leg, 2026-11-19.)
 */
export function decideDuplicate(input: {
  requestedRole: DealInputRole | null;
  requestedPath: string;
  priorPath: string;
}): DuplicateDecision {
  if (!input.requestedRole) return { ok: true, path: input.priorPath, role: null };
  if (input.priorPath === input.requestedPath) {
    return { ok: true, path: input.priorPath, role: input.requestedRole };
  }
  return {
    ok: false,
    code: "role_conflict",
    message:
      `Those exact bytes are already stored as "${input.priorPath}". ` +
      `Rename the file or remove the earlier copy before binding it to ${input.requestedRole}.`,
  };
}

// ── Listing ─────────────────────────────────────────────────────────

export type ListingRead =
  | {
      status: "ok";
      sha256: string;
      kind: "pdf" | "text";
      /** Whole document, page separators preserved. */
      text: string;
      /** Per-page text, 1-based page numbers — the locator a citation needs. */
      pages: { page: number; text: string }[];
      chars: number;
    }
  | { status: "needs-text"; sha256: string; numberOfPages: number; reason: "scan" | "unreadable" | "too_short" };

/**
 * Extract the listing. A PDF with no text layer is NOT an error and NOT an
 * empty listing: it is `needsText`, so the runner asks for the text instead of
 * analysing a blank page.
 */
export async function readListing(bytes: Uint8Array, kind: SniffedKind): Promise<ListingRead> {
  const sha256 = sha256Hex(bytes);
  if (kind === "pdf") {
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
      getDocument: (opts: Record<string, unknown>) => { promise: Promise<PdfDocument> };
    };
    // NOTE for phase E: this dynamic import is only load-bearing once the runner
    // imports readListing(). Until then the route tree-shakes this whole module
    // out (checked: the built server had no "pdfjs" string). When E wires the
    // runner, build and then grep .output/server for a pdfjs-dist chunk before
    // trusting the lane — a silent tree-shake is fine, a missing chunk at
    // runtime is a broken listing read.
    let doc: PdfDocument;
    try {
      // pdf.js takes ownership of the buffer it is given; hand it a copy so the
      // caller's sha256 still describes the bytes we hashed.
      doc = await pdfjs.getDocument({
        data: new Uint8Array(bytes),
        useSystemFonts: true,
        isEvalSupported: false,
        disableFontFace: true,
      }).promise;
    } catch {
      // A PDF we cannot parse is not a crash and not an empty document: ask
      // for the text. Losing the whole turn to a bad header is the worse bug.
      return { status: "needs-text", sha256, numberOfPages: 0, reason: "unreadable" };
    }
    const pages: { page: number; text: string }[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      pages.push({ page: p, text: itemsToText(content.items as PdfTextItem[]) });
    }
    const text = pages.map((p) => p.text).join("\n\n");
    if (text.replace(/\s/g, "").length < 40) {
      return { status: "needs-text", sha256, numberOfPages: doc.numPages, reason: "scan" };
    }
    return { status: "ok", sha256, kind: "pdf", text, pages, chars: text.length };
  }

  const text = Buffer.from(bytes).toString("utf8").replace(/^\uFEFF/, "");
  if (text.trim().length < 200) {
    return { status: "needs-text", sha256, numberOfPages: 1, reason: "too_short" };
  }
  return { status: "ok", sha256, kind: "text", text, pages: [{ page: 1, text }], chars: text.length };
}

interface PdfTextItem {
  str: string;
  transform?: number[];
}

interface PdfDocument {
  numPages: number;
  getPage(page: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
}

/**
 * Assemble lines from pdf.js text items. Items arrive in draw order, not
 * reading order, and dropping them into one string loses every line break —
 * which turns a citations list into a word salad. Grouping by the item's
 * baseline (transform[5]) is what makes "Notes from the offering memorandum:"
 * a line again.
 */
function itemsToText(items: PdfTextItem[]): string {
  const lines: { y: number; parts: { x: number; str: string }[] }[] = [];
  for (const item of items) {
    if (!item.str) continue;
    const transform = item.transform ?? [1, 0, 0, 1, 0, 0];
    const x = transform[4] ?? 0;
    const y = Math.round(transform[5] ?? 0);
    const line = lines.find((l) => Math.abs(l.y - y) <= 2);
    if (line) line.parts.push({ x, str: item.str });
    else lines.push({ y, parts: [{ x, str: item.str }] });
  }
  return lines
    .sort((a, b) => b.y - a.y)
    .map((l) =>
      l.parts
        .sort((a, b) => a.x - b.x)
        .map((p) => p.str)
        .join("")
        .replace(/\s+$/, ""),
    )
    .join("\n");
}

// ── Tabular inputs ──────────────────────────────────────────────────

async function xlsxToCsv(bytes: Uint8Array): Promise<{ csv: string; sheet: string }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes) as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("XLSX_NO_SHEET the workbook has no worksheets");
  const lines: string[] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    // row.values is 1-based with a hole at index 0.
    const values = row.values as (ExcelJS.CellValue | undefined)[];
    for (let c = 1; c < values.length; c++) {
      const value = values[c];
      let text = "";
      if (value === null || value === undefined) text = "";
      else if (typeof value === "object" && value !== null && "text" in value && typeof (value as { text: unknown }).text === "string") {
        text = (value as { text: string }).text;
      } else if (typeof value === "object" && value !== null && "result" in value) {
        text = String((value as { result: unknown }).result ?? "");
      } else text = String(value);
      cells.push(quoteCsvCell(text));
    }
    lines.push(cells.join(","));
  });
  return { csv: lines.join("\n"), sheet: sheet.name };
}

function quoteCsvCell(text: string): string {
  const s = text.replace(/\r?\n/g, " ").trim();
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface SheetNote {
  /** Row numbers in the sheet do not line up with CSV lines once blank rows are skipped. */
  sheet: string;
  rows: number;
}

export interface ParsedRentRollFile extends ParsedRentRoll {
  sha256: string;
  source: "csv" | "xlsx";
  sheet?: string;
}

export async function readRentRoll(bytes: Uint8Array, kind: SniffedKind): Promise<ParsedRentRollFile> {
  const sha256 = sha256Hex(bytes);
  if (kind === "zip") {
    const { csv, sheet } = await xlsxToCsv(bytes);
    const parsed = parseRentRollCsv(csv);
    checkRowCap("rent_roll", parsed.rows.length, DEAL_ROLES.rent_roll.maxRows);
    return { ...parsed, sha256, source: "xlsx", sheet };
  }
  const parsed = parseRentRollCsv(Buffer.from(bytes).toString("utf8"));
  checkRowCap("rent_roll", parsed.rows.length, DEAL_ROLES.rent_roll.maxRows);
  return { ...parsed, sha256, source: "csv" };
}

export interface ParsedCompsFile extends ParsedComps {
  sha256: string;
  source: "csv" | "xlsx";
  sheet?: string;
}

export async function readComps(bytes: Uint8Array, kind: SniffedKind): Promise<ParsedCompsFile> {
  const sha256 = sha256Hex(bytes);
  if (kind === "zip") {
    const { csv, sheet } = await xlsxToCsv(bytes);
    const parsed = parseCompsCsv(csv);
    checkRowCap("comps", parsed.comps.length + parsed.rejected.length, DEAL_ROLES.comps.maxRows);
    return { ...parsed, sha256, source: "xlsx", sheet };
  }
  const parsed = parseCompsCsv(Buffer.from(bytes).toString("utf8"));
  checkRowCap("comps", parsed.comps.length + parsed.rejected.length, DEAL_ROLES.comps.maxRows);
  return { ...parsed, sha256, source: "csv" };
}

function checkRowCap(label: string, rows: number, cap: number | null): void {
  if (cap !== null && rows > cap) {
    throw new Error(`${label.toUpperCase()}_TOO_MANY_ROWS ${rows} rows; the limit is ${cap}`);
  }
}

// ── Photos ──────────────────────────────────────────────────────────

export interface StoredPhoto {
  sha256: string;
  bytes: Uint8Array;
  contentType: string;
  /** Metadata carriers removed before hashing, e.g. ["APP1"]. */
  removed: string[];
}

export function readPhoto(bytes: Uint8Array, kind: SniffedKind): StoredPhoto {
  const stripped = stripImageMetadata(bytes);
  if (stripped.kind !== "jpeg" && stripped.kind !== "png") {
    throw new Error(`PHOTO_UNSUPPORTED only JPEG and PNG are scrubbed, got ${stripped.kind}`);
  }
  return {
    sha256: sha256Hex(stripped.bytes),
    bytes: stripped.bytes,
    contentType: stripped.kind === "jpeg" ? "image/jpeg" : "image/png",
    removed: stripped.removed,
  };
}

// ── The ledger ──────────────────────────────────────────────────────

export type LedgerEntry =
  | { role: "listing"; sha256: string; bytes: number; kind: string; pages: number; chars: number }
  | { role: "rent_roll"; sha256: string; bytes: number; kind: string; rows: number; totalSf: number }
  | { role: "comps"; sha256: string; bytes: number; kind: string; rows: number; kept: number }
  | { role: "photos"; sha256: string; bytes: number; kind: string; removed: string[] };

/**
 * What may be written down. No filenames, no tenant names, no text. If a field
 * is not in this function it does not reach a log, a job row or an error.
 */
export function toLedger(input:
  | { role: "listing"; listing: ListingRead; bytes: number }
  | { role: "rent_roll"; file: ParsedRentRollFile; bytes: number; totalSf: number }
  | { role: "comps"; file: ParsedCompsFile; bytes: number; kept: number }
  | { role: "photos"; photo: StoredPhoto; bytes: number; kind: string },
): LedgerEntry {
  switch (input.role) {
    case "listing":
      return {
        role: "listing",
        sha256: input.listing.sha256,
        bytes: input.bytes,
        kind: input.listing.status === "needs-text" ? "needs-text" : input.listing.kind,
        pages: input.listing.status === "needs-text" ? input.listing.numberOfPages : input.listing.pages.length,
        chars: input.listing.status === "needs-text" ? 0 : input.listing.chars,
      };
    case "rent_roll":
      return {
        role: "rent_roll",
        sha256: input.file.sha256,
        bytes: input.bytes,
        kind: input.file.source,
        rows: input.file.rows.length,
        totalSf: input.totalSf,
      };
    case "comps":
      return {
        role: "comps",
        sha256: input.file.sha256,
        bytes: input.bytes,
        kind: input.file.source,
        rows: input.file.comps.length + input.file.rejected.length,
        kept: input.kept,
      };
    case "photos":
      return {
        role: "photos",
        sha256: input.photo.sha256,
        bytes: input.photo.bytes.byteLength,
        kind: input.kind,
        removed: input.photo.removed,
      };
  }
}
