/**
 * CR-9 phase C — the output gate.
 *
 * What this proves with real bytes, not intentions:
 *   1. the stress table the user downloads as CSV is byte-for-byte the table
 *      the acceptance fixture pins (`expected_stress_table.csv`), built from the
 *      same loan and the same NOI;
 *   2. the memo fixture renders to exactly two pages, and the page count the
 *      renderer reports is the count written into the PDF (`/Count`);
 *   3. a body that needs three pages fails by name — `C39_PAGE_LIMIT` — and is
 *      never truncated to fit;
 *   4. the Word file exists (a real ZIP, PK header), keeps the stress table's
 *      numbers, and is produced by the same typed renderer the chat uses;
 *   5. table rows are drawn in the Courier table mode inside the line width,
 *      so a stress table cannot re-flow into unaligned soup;
 *   6. the stored content type comes from the sniffed bytes, not the browser's
 *      guess from the extension;
 *   7. the CSV writer round-trips a quoted field through the reader.
 *
 * Run: npx tsx scripts/test-cre-outputs.ts
 */
import { readFileSync } from "node:fs";

import { parseAssumptions } from "../src/lib/buzzy/cre/assumptions";
import { contentTypeForKind, sniffKind } from "../src/lib/buzzy/cre/bytes";
import { parseCsvTable } from "../src/lib/buzzy/cre/csv";
import { dollarsToCents, effectiveGrossIncomeCents, netOperatingIncomeCents, replacementReservesCents } from "../src/lib/buzzy/cre/math";
import {
  documentContentFromMarkdown,
  markdownTableToCsv,
  markdownTables,
  renderDealMemo,
  stressTableToCsv,
  writeCsv,
} from "../src/lib/buzzy/cre/outputs";
import { parseRentRollCsv, summariseRentRoll } from "../src/lib/buzzy/cre/rentRoll";
import { buildStressTable } from "../src/lib/buzzy/cre/stress";
import { renderTextPdfDocument } from "../src/lib/buzzy/pdf";

const fixture = (name: string): string =>
  readFileSync(new URL(`../src/lib/buzzy/cre/fixtures/${name}`, import.meta.url), "utf8");
/** Uint8Array.toString takes no encoding — go through Buffer for byte inspection. */
const latin1 = (b: Uint8Array): string => Buffer.from(b).toString("latin1");
const AS_OF = "2026-11-19";

let passes = 0;
const failures: string[] = [];
function ok(label: string, condition: boolean, detail = "") {
  if (condition) {
    passes++;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(label: string, actual: unknown, want: unknown) {
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  ok(label, a === w, a === w ? "" : `got ${a}, want ${w}`);
}

// ── The same loan the acceptance fixture uses ─────────────────────────
const assumptions = parseAssumptions(JSON.parse(fixture("assumptions.placeholder.json")));
const rentRoll = parseRentRollCsv(fixture("rent_roll.csv"));
const rr = summariseRentRoll(rentRoll.rows, { asOf: AS_OF, termYears: 10, issues: rentRoll.issues });
const egi = effectiveGrossIncomeCents({
  inPlaceRentCents: rr.annualBaseRentCents,
  reimbursementsCents: dollarsToCents(54_000),
  vacancyBp: assumptions.vacancyBp,
});
const noi = netOperatingIncomeCents({
  egiCents: egi,
  opexCents: dollarsToCents(78_000),
  reservesCents: replacementReservesCents(rr.totalSf, assumptions.reservesCentsPerSf),
});
const loan = JSON.parse(fixture("loan_request.json")) as {
  loan_amount_usd: number;
  note_rate_pct_base: number;
  amortization_years: number;
};
const stress = buildStressTable({
  noiCents: noi,
  loanCents: dollarsToCents(loan.loan_amount_usd),
  valueCents: dollarsToCents(2_600_000),
  noteRateBp: Math.round(loan.note_rate_pct_base * 100),
  amortizationYears: loan.amortization_years,
  thresholds: {
    dscrMinX100: assumptions.dscrMinX100,
    ltvMaxBp: assumptions.ltvMaxBp,
    debtYieldMinBp: assumptions.debtYieldMinBp,
  },
  capRateExpansionBp: 0,
});

// ── 1. CSV writer against the pinned table ────────────────────────────
console.log("\nstress CSV — byte-for-byte the acceptance fixture");
const wantCsv = fixture("expected_stress_table.csv").replace(/\r\n/g, "\n");
const gotCsv = stressTableToCsv(stress);
eq("the spreadsheet is the pinned table", gotCsv, wantCsv);
eq("three data rows", gotCsv.trim().split("\n").length, 4);
const back = parseCsvTable(gotCsv);
eq("and it reads back as a table", [back.headers.length, back.rows.length], [7, 3]);
eq("+200bp scenario label survives", back.rows[2]!.scenario, "+200bp");

console.log("\ncsv writer — quoting");
const quoted = writeCsv(["name", "rent"], [["Elm Portfolio, 3 bldgs", 1200], ['Say "hi"', null]]);
ok("a field with a comma is quoted", quoted.includes('"Elm Portfolio, 3 bldgs"'), quoted.split("\n")[1]);
ok("an embedded quote is doubled", quoted.includes('"Say ""hi"""'), quoted.split("\n")[2]);
const roundTrip = parseCsvTable(quoted);
eq("and the reader gets the original text back", roundTrip.rows[0]!.name, "Elm Portfolio, 3 bldgs");
eq("a null is an empty cell", roundTrip.rows[1]!.rent, "");

// ── 2. The memo fixture is two pages ─────────────────────────────────
console.log("\nthe memo — two pages, and the file says so");
const memo = fixture("deal_memo.md");
const direct = renderTextPdfDocument("Lender-Ready Deal Memo — Maple Court Retail Center", memo, { maxPages: 2 });
eq("renders to exactly two pages", direct.pageCount, 2);
ok("reports within the limit", direct.withinLimit === true);
const declared = Number(latin1(direct.bytes).match(/\/Type \/Pages[^>]*\/Count (\d+)/)?.[1]);
eq("the reported count is the PDF's own /Count", declared, direct.pageCount);
ok("is a PDF", latin1(direct.bytes.subarray(0, 5)) === "%PDF-");
ok("carries the advice notice", latin1(direct.bytes).includes("not financial, investment or legal advice"));

// Table mode: every drawn text line fits the printable width, and the table
// rows use the Courier face rather than Helvetica 12pt.
console.log("\ntable mode — fixed-width rows that fit the page");
const streams = latin1(direct.bytes);
ok("the Courier face is in the file", streams.includes("/BaseFont /Courier"));
const drawn = [...streams.matchAll(/\((.*?)\) Tj/g)].map((m) => m[1]!);
const widest = drawn.reduce((n, s) => Math.max(n, s.length), 0);
ok("no drawn line exceeds 88 characters", widest <= 88, `widest ${widest}`);
ok("the stress table's +200bp row is drawn", drawn.some((s) => s.includes("+200bp") && s.includes("$166,731")), "");
ok("table rows switch to Courier 9pt", streams.includes("/F2 9 Tf"));

// ── 3. Over-budget fails closed, by name ─────────────────────────────
console.log("\nover-budget — refused, not truncated");
const forced = memo + "\n" + memo.split("\n").slice(1).join("\n");
const forcedRender = renderTextPdfDocument("Lender-Ready Deal Memo", forced, { maxPages: 2 });
ok("a doubled body needs more than two pages", forcedRender.pageCount > 2, `got ${forcedRender.pageCount}`);
ok("and reports it is over the limit", forcedRender.withinLimit === false);
const forcedOut = await renderDealMemo({ title: "Lender-Ready Deal Memo", markdown: forced, maxPages: 2 });
eq("renderDealMemo refuses it", forcedOut.ok, false);
if (!forcedOut.ok) {
  eq("with the named code C39_PAGE_LIMIT", forcedOut.code, "C39_PAGE_LIMIT");
  ok("and a message that names the counts", /(\d+) pages; the limit is 2/.test(forcedOut.message), forcedOut.message);
  eq("no files are handed over", Object.prototype.hasOwnProperty.call(forcedOut, "files"), false);
}
const tightBudget = await renderDealMemo({ title: "Lender-Ready Deal Memo", markdown: memo, maxPages: 1 });
eq("a one-page budget refuses the two-page memo too", tightBudget.ok ? null : tightBudget.code, "C39_PAGE_LIMIT");
const empty = await renderDealMemo({ title: "x", markdown: "   " });
eq("an empty memo is refused", empty.ok ? null : empty.code, "EMPTY_MEMO");

// ── 4. The four files ────────────────────────────────────────────────
console.log("\nthe four files");
const out = await renderDealMemo({ title: "Lender-Ready Deal Memo — Maple Court Retail Center", markdown: memo });
eq("renders", out.ok, true);
if (out.ok) {
  eq("pages", out.limits.pageCount, 2);
  eq("limit", out.limits.maxPages, 2);
  ok("the Word file is a real ZIP", latin1(out.files.docx.bytes.subarray(0, 2)) === "PK");
  ok("the Word file is not tiny", out.files.docx.bytes.byteLength > 2000, `${out.files.docx.bytes.byteLength} B`);
  eq("Word content type", out.files.docx.contentType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  eq("Word filename", out.files.docx.filename, "lender-ready-deal-memo-maple-court-retail-center-fictional.docx");
  ok("the markdown is the canonical text", out.files.markdown.trimEnd() === memo.trimEnd(), `${out.files.markdown.length} B`);
  ok("and ends with exactly one newline", out.files.markdown.endsWith("\n") && !out.files.markdown.endsWith("\n\n"));
  const memoCsv = parseCsvTable(out.files.csv ?? "");
  eq("the CSV is the memo's table, not prose", [memoCsv.headers.length, memoCsv.rows.length], [7, 3]);
  eq("with the base row's figures intact", [memoCsv.rows[0]!.note_rate, memoCsv.rows[0]!.dscr, memoCsv.rows[0]!.ltv], ["6.75%", "1.31x", "65.00%"]);
  ok("a money cell with a comma stays one cell", memoCsv.rows[0]!.annual_debt_service === "$140,117", memoCsv.rows[0]!.annual_debt_service);
  ok("the PDF is 2 pages", out.files.pdf.pageCount === 2);
}

// ── 5. Markdown -> typed content keeps the numbers ───────────────────
console.log("\nmarkdown -> render_document content");
const shaped = documentContentFromMarkdown(memo, "Deal Memo");
eq("shapes", shaped.ok, true);
if (shaped.ok) {
  eq("keeps the title", shaped.content.title, "Lender-Ready Deal Memo — Maple Court Retail Center (fictional)");
  const all = shaped.content.sections.flatMap((s) => s.paragraphs).join("\n");
  ok("keeps the base debt service", all.includes("$140,117"));
  ok("keeps the +200bp debt service", all.includes("$166,731"));
  ok("keeps every section heading", shaped.content.sections.some((s) => s.heading === "Rate stress"));
  ok("a table row is a paragraph, not a dropped line", all.includes("Base  |  6.75%  |  $140,117"));
  eq("no section is empty", shaped.content.sections.every((s) => s.paragraphs.length > 0), true);
}
const noBody = documentContentFromMarkdown("", "x");
eq("an empty text is refused", noBody.ok, false);

// ── 6. CSV export finds only real tables ─────────────────────────────
console.log("\nmarkdown tables — real tables only");
const tables = markdownTables(memo);
eq("the memo has one table", tables.length, 1);
eq("with a header row", tables[0]!.headers[0], "Scenario");
eq("and the separator line is not a data row", tables[0]!.rows.length, 3);
eq("prose with a pipe is not a table", markdownTableToCsv("See the note | the other note\nnothing else here"), null);
eq("no table means no CSV", markdownTableToCsv("# Title\n\nJust words."), null);
const twoTables = markdownTableToCsv("| a | b |\n| --- | --- |\n| 1 | 2 |\n\n| c |\n| --- |\n| 3 |\n");
ok("two tables both survive, separated by a blank line", (twoTables ?? "").trim() === "a,b\n1,2\n\nc\n3", JSON.stringify(twoTables));

// ── 7. Content type from the bytes ───────────────────────────────────
console.log("\ncontent type — from the sniff, not the extension");
eq("pdf bytes are application/pdf", contentTypeForKind(sniffKind(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))), "application/pdf");
eq("a rent-roll ZIP is an xlsx", contentTypeForKind("zip", "rent_roll"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
eq("a comps ZIP is an xlsx", contentTypeForKind("zip", "comps"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
eq("another ZIP stays a zip", contentTypeForKind("zip"), "application/zip");
eq("a JPEG is image/jpeg", contentTypeForKind("jpeg"), "image/jpeg");
eq("a listing with commas sniffs as tabular text", contentTypeForKind(sniffKind(new Uint8Array(Buffer.from(fixture("rent_roll.csv"), "utf8")))), "text/csv; charset=utf-8");
eq("plain prose is text/plain", contentTypeForKind(sniffKind(new Uint8Array(Buffer.from("a listing with no commas at all", "utf8")))), "text/plain; charset=utf-8");
eq("csv is text/csv", contentTypeForKind(sniffKind(new Uint8Array(Buffer.from(fixture("rent_roll.csv"), "utf8")))), "text/csv; charset=utf-8");

// ── 8. The four files land in buzzy_assets ───────────────────────────
// Hermetic: an in-memory PGlite with only the migrations this module reads.
console.log("\nstorage — one row per file, idempotent, job-scoped");
const { PGlite } = await import("@electric-sql/pglite");
const { storeMemoFiles } = await import("../src/lib/buzzy/cre/store");
const db = new PGlite();
const q = async <T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> =>
  (await db.query<T>(text, params ?? [])).rows;
for (const file of ["0048_buzzy_assets.sql", "0052_buzzy_project_deliverables.sql"]) {
  await db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
}
await db.exec("DROP TABLE IF EXISTS buzzy_turn_log, buzzy_session_log CASCADE");
const USER = "acct_memo_test";
const stored = out.ok
  ? await storeMemoFiles(q, { userId: USER, files: out.files, jobId: "job_memo_1", title: "Lender-Ready Deal Memo" })
  : { assets: [] };
eq("four files stored", stored.assets.length, 4);
eq("formats", stored.assets.map((a) => a.format).join(","), "md,pdf,docx,csv");
eq("every file has a working download URL", stored.assets.every((a) => a.url === `/api/buzzy/assets/${a.id}`), true);
eq("paths are job-scoped", stored.assets.every((a) => a.relPath.startsWith("deal-memo/job_memo_1/")), true);
eq("the Word row is labelled as Word", stored.assets.find((a) => a.format === "docx")!.contentType,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
const rows = await q<{ filename: string; content_type: string; bytes: number; job_id: string; sha256: string }>(
  "SELECT filename, content_type, bytes, job_id, sha256 FROM buzzy_assets WHERE user_id = $1 ORDER BY id",
  [USER],
);
eq("four rows in the table", rows.length, 4);
eq("each row names its job", rows.every((r) => r.job_id === "job_memo_1"), true);
eq("the PDF row's byte count is the real file's", rows.find((r) => r.filename.endsWith(".pdf"))!.bytes, out.ok ? out.files.pdf.bytes.byteLength : -1);
eq("the sha256 is a real digest", rows.every((r) => /^[0-9a-f]{64}$/.test(r.sha256)), true);
const again = out.ok
  ? await storeMemoFiles(q, { userId: USER, files: out.files, jobId: "job_memo_1", title: "Lender-Ready Deal Memo" })
  : { assets: [] };
eq("re-storing the same bytes creates no second row", (await q("SELECT id FROM buzzy_assets WHERE user_id = $1", [USER])).length, 4);
eq("and reports duplicates, not new assets", again.assets.every((a) => a.duplicate), true);
eq("with the same ids", again.assets.map((a) => a.id).join(","), stored.assets.map((a) => a.id).join(","));
await db.close();

console.log(`\n${passes} passed, ${failures.length} failed`);
if (failures.length) {
  console.error(`failed: ${failures.join(" | ")}`);
  process.exit(1);
}
