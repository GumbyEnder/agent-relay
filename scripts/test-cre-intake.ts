/**
 * CR-9 phase B — intake gate.
 *
 * Proves four things with real bytes, not assertions about intent:
 *   1. a file is accepted or refused by what it IS (magic bytes), not by its
 *      name, and each role has its own allowlist and cap;
 *   2. the listing's text comes out with page locators, and a scan says so
 *      instead of pretending to be empty;
 *   3. the rent roll parses from BOTH the real CSV fixture and an XLSX built
 *      from the same rows;
 *   4. a photo's EXIF is gone before it is hashed, and the ledger carries no
 *      filename, tenant name or line of text.
 *
 * Run: npx tsx scripts/test-cre-intake.ts
 */
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";

import { renderTextPdf } from "../src/lib/buzzy/pdf";
import { sha256Hex, sniffKind, stripImageMetadata } from "../src/lib/buzzy/cre/bytes";
import {
  bindRole,
  DEAL_ROLES,
  decideDuplicate,
  readComps,
  readListing,
  readPhoto,
  readRentRoll,
  toLedger,
} from "../src/lib/buzzy/cre/intake";

const fixture = (name: string): string =>
  readFileSync(new URL(`../src/lib/buzzy/cre/fixtures/${name}`, import.meta.url), "utf8");
const fixtureBytes = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../src/lib/buzzy/cre/fixtures/${name}`, import.meta.url)));

let passes = 0;
const failures: string[] = [];
function ok(label: string, condition: boolean, detail = "") {
  if (condition) { passes++; console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`); }
  else { failures.push(label); console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
}
function eq(label: string, actual: unknown, want: unknown) {
  ok(label, actual === want, `got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`);
}
function throws(label: string, fn: () => unknown, match: RegExp) {
  try { fn(); ok(label, false, "did not throw"); }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ok(label, match.test(message), message);
  }
}
async function rejects(label: string, fn: () => Promise<unknown>, match: RegExp) {
  try { await fn(); ok(label, false, "did not throw"); }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ok(label, match.test(message), message);
  }
}

// ── Synthetic images with real metadata segments ────────────────────
function segment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function jpegWithExif(): Uint8Array {
  const exif = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from("GPSLatitude 51.5 GPSLongitude -0.1 Camera Serial 99\r\n", "latin1")]);
  const xmp = Buffer.from("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>author</x:xmpmeta>", "latin1");
  return new Uint8Array(Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe1, exif),
    segment(0xe1, xmp),
    segment(0xfe, Buffer.from("shot by a phone", "latin1")),
    Buffer.from([0xff, 0xda, 0x00, 0x02]),
    Buffer.from([0x11, 0x22, 0x33, 0x44]),
    Buffer.from([0xff, 0xd9]),
  ]));
}

function crc32Dummy(): Buffer {
  return Buffer.from([0, 0, 0, 0]);
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, data, crc32Dummy()]);
}

function pngWithMetadata(): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(64, 0);
  ihdr.writeUInt32BE(64, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("eXIf", Buffer.from("Exif\0\0GPSLatitude", "latin1")),
    chunk("tEXt", Buffer.from("Author\0Shane", "latin1")),
    chunk("IDAT", Buffer.from([1, 2, 3, 4])),
    chunk("IEND", Buffer.alloc(0)),
  ]));
}

async function main() {
  // ── Role binding ──────────────────────────────────────────────────
  console.log("\nrole binding — the bytes decide, not the name");
  const rentRollBytes = fixtureBytes("rent_roll.csv");
  const boundRentRoll = bindRole({ role: "rent_roll", filename: "rent_roll.csv", bytes: rentRollBytes });
  eq("rent_roll.csv accepted as a rent roll", boundRentRoll.ok, true);
  eq("its hash is the sha256 of the bytes", boundRentRoll.ok ? boundRentRoll.sha256 : null, sha256Hex(rentRollBytes));

  const wrongRole = bindRole({ role: "photos", filename: "rent_roll.csv", bytes: rentRollBytes });
  eq("a CSV is refused as a photo", wrongRole.ok, false);
  eq("refusal names the extension rule", wrongRole.ok ? "" : wrongRole.code, "wrong_extension");

  const pdfAsRentRoll = bindRole({ role: "rent_roll", filename: "listing.pdf", bytes: fixtureBytes("listing.txt") });
  eq("listing.txt named .pdf is refused", pdfAsRentRoll.ok, false);

  const disguised = bindRole({ role: "rent_roll", filename: "rent_roll.xlsx", bytes: rentRollBytes });
  eq("a CSV named .xlsx is accepted only because the bytes are parseable text", disguised.ok, true);
  eq("and the sniffed kind is csv", disguised.ok ? disguised.kind : null, "csv");

  const big = new Uint8Array(6 * 1024 * 1024);
  big.set(rentRollBytes, 0);
  const tooBig = bindRole({ role: "rent_roll", filename: "rent_roll.csv", bytes: big });
  eq("a 6 MB rent roll is refused", tooBig.ok, false);
  eq("the refusal is file_too_large", tooBig.ok ? "" : tooBig.code, "file_too_large");

  eq("roles are the four the spec names", JSON.stringify(Object.keys(DEAL_ROLES)), JSON.stringify(["listing", "rent_roll", "comps", "photos"]));

  // ── Listing ───────────────────────────────────────────────────────
  console.log("\nlisting — text with page locators, and an honest scan");
  const listingText = fixture("listing.txt");
  const listing = await readListing(new TextEncoder().encode(listingText), "text");
  eq("text listing reads as ok", listing.status, "ok");
  eq("and is one page", listing.status === "ok" ? listing.pages.length : 0, 1);
  ok("the asking price survives", listing.status === "ok" && listing.text.includes("Asking price: $2,600,000"));
  ok("the co-tenancy note survives", listing.status === "ok" && /co-tenancy/i.test(listing.text));

  const twoPageBody = [
    "Maple Court Retail Center (fictional)",
    "",
    "Asking price: $2,600,000",
    "",
    ...Array.from({ length: 90 }, (_, i) => `Offering memorandum note ${i + 1}: fictional text for pagination.`),
  ].join("\n");
  const pdf = renderTextPdf("Maple Court (fictional)", twoPageBody);
  const pdfListing = await readListing(pdf, "pdf");
  eq("a generated PDF reads as ok", pdfListing.status, "ok");
  eq("and has two pages", pdfListing.status === "ok" ? pdfListing.pages.length : 0, 2);
  ok("page 1 carries the price line", pdfListing.status === "ok" && /Asking price/.test(pdfListing.pages[0]!.text));
  ok("page 2 is not empty", pdfListing.status === "ok" && pdfListing.pages[1]!.text.trim().length > 0);
  ok("line breaks are preserved, not mashed into one line", pdfListing.status === "ok" && pdfListing.text.split("\n").length > 20);

  const scan = await readListing(new Uint8Array(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])), "pdf");
  eq("a PDF that will not parse is reported, not swallowed", scan.status, "needs-text");

  const stub = await readListing(new TextEncoder().encode("short"), "text");
  eq("a 5-character pasted listing is asked for again", stub.status, "needs-text");

  // ── Rent roll: CSV and XLSX ───────────────────────────────────────
  console.log("\nrent roll — the real fixture, then the same rows as a spreadsheet");
  const csvRentRoll = await readRentRoll(rentRollBytes, "csv");
  eq("four suites from CSV", csvRentRoll.rows.length, 4);
  eq("source is csv", csvRentRoll.source, "csv");
  eq("row locators are the file lines", JSON.stringify(csvRentRoll.rows.map((r) => r.sourceRow)), JSON.stringify([2, 3, 4, 5]));
  eq("Example Coffee annual rent $56,000", csvRentRoll.rows[0]!.annualRentCents, 5_600_000);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Rent Roll");
  sheet.addRow(["suite", "tenant", "sf", "base_rent_per_sf_yr", "lease_start", "lease_end", "lease_type"]);
  sheet.addRow(["100", "Example Coffee Co. (fictional)", 2000, 28.0, "2022-07-01", "2029-06-30", "NNN"]);
  sheet.addRow(["110", "Sample Dental LLC (fictional)", 3000, 24.0, "2021-01-01", "2031-12-31", "NNN"]);
  sheet.addRow(["120", "Demo Fitness Inc. (fictional)", 6000, 16.0, "2017-04-01", "2027-03-31", "NNN"]);
  sheet.addRow(["130", "VACANT", 2500, 0, "", "", ""]);
  const xlsx = new Uint8Array(await workbook.xlsx.writeBuffer());
  eq("the generated workbook sniffs as zip/office", sniffKind(xlsx), "zip");
  const xlsxRentRoll = await readRentRoll(xlsx, "zip");
  eq("four suites from XLSX", xlsxRentRoll.rows.length, 4);
  eq("source is xlsx", xlsxRentRoll.source, "xlsx");
  eq("sheet name carried through", xlsxRentRoll.sheet, "Rent Roll");
  eq("same tenant, same rent as the CSV", xlsxRentRoll.rows[0]!.annualRentCents, csvRentRoll.rows[0]!.annualRentCents);
  eq("VACANT suite is still vacant", xlsxRentRoll.rows[3]!.vacant, true);
  eq("XLSX rows still carry locators", xlsxRentRoll.rows.every((r) => (r.sourceRow ?? 0) > 0), true);

  const many = ["suite,tenant,sf,base_rent_per_sf_yr"];
  for (let i = 0; i < 501; i++) many.push(`${i},Tenant ${i},1000,20`);
  await rejects(
    "501 rent-roll rows are refused, not silently truncated",
    () => readRentRoll(new TextEncoder().encode(many.join("\n")), "csv"),
    /RENT_ROLL_TOO_MANY_ROWS 501 rows/,
  );

  // ── Comps ─────────────────────────────────────────────────────────
  console.log("\ncomps — the fixture file, through the same door");
  const compsFile = await readComps(fixtureBytes("comps.csv"), "csv");
  eq("seven comps", compsFile.comps.length, 7);
  eq("first comp locator is line 2", compsFile.comps[0]!.sourceRow, 2);
  eq("the quoted portfolio name survives the comma", compsFile.comps[3]!.name, "Elm Portfolio, 3 bldgs (fictional)");

  // ── Photos ────────────────────────────────────────────────────────
  console.log("\nphotos — metadata removed before the hash");
  const jpeg = jpegWithExif();
  ok("the synthetic JPEG starts with EXIF and a GPS string", Buffer.from(jpeg).toString("latin1").includes("GPSLatitude"));
  const photo = readPhoto(jpeg, "jpeg");
  eq("APP1 and COM segments are removed", JSON.stringify(photo.removed), JSON.stringify(["APP1", "APP1", "COM"]));
  ok("no EXIF marker survives", !Buffer.from(photo.bytes).toString("latin1").includes("Exif\0\0"));
  ok("no GPS string survives", !Buffer.from(photo.bytes).toString("latin1").includes("GPSLatitude"));
  ok("the image data survives", Buffer.from(photo.bytes).toString("latin1").includes("\x11\x22\x33\x44"));
  ok("the stored bytes are shorter than the upload", photo.bytes.byteLength < jpeg.byteLength);
  eq("the hash describes the stripped bytes, not the original", photo.sha256, sha256Hex(photo.bytes));
  ok("and differs from the original's hash", photo.sha256 !== sha256Hex(jpeg));

  const png = pngWithMetadata();
  const pngPhoto = readPhoto(png, "png");
  eq("PNG eXIf and tEXt are removed", JSON.stringify(pngPhoto.removed), JSON.stringify(["eXIf", "tEXt"]));
  ok("the author name is gone", !Buffer.from(pngPhoto.bytes).toString("latin1").includes("Shane"));
  ok("IHDR and IDAT survive", Buffer.from(pngPhoto.bytes).toString("latin1").includes("IHDR") && Buffer.from(pngPhoto.bytes).toString("latin1").includes("IDAT"));
  eq("content type is image/png", pngPhoto.contentType, "image/png");

  throws("a HEIC-style file is refused, not stored unscanned", () => readPhoto(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]), "unknown"), /PHOTO_UNSUPPORTED/);

  const direct = stripImageMetadata(jpeg);
  eq("stripping twice is idempotent", stripImageMetadata(direct.bytes).removed.length, 0);

  // ── Duplicate bytes: a repeat is a hit, a role change is a refusal ──
  console.log("\nduplicate uploads — content addressing must not fake a role path");
  {
    const same = decideDuplicate({
      requestedRole: "rent_roll",
      requestedPath: "deals/rent_roll/rent_roll.csv",
      priorPath: "deals/rent_roll/rent_roll.csv",
    });
    ok("a repeat of the same role and path is a duplicate hit", same.ok && same.role === "rent_roll");
    eq("the hit keeps the stored path", same.ok ? same.path : null, "deals/rent_roll/rent_roll.csv");

    const legacy = decideDuplicate({
      requestedRole: null,
      requestedPath: "listing.txt",
      priorPath: "deals/listing/listing.txt",
    });
    ok("a role-less repeat still resolves to the stored row", legacy.ok && legacy.role === null);
    eq("a role-less repeat echoes the stored path", legacy.ok ? legacy.path : null, "deals/listing/listing.txt");

    const stolen = decideDuplicate({
      requestedRole: "listing",
      requestedPath: "deals/listing/listing.txt",
      priorPath: "listing.txt",
    });
    ok(
      "the same bytes already uploaded without a role refuse a role binding",
      !stolen.ok && stolen.code === "role_conflict",
      stolen.ok ? "accepted" : stolen.message,
    );

    const crossRole = decideDuplicate({
      requestedRole: "comps",
      requestedPath: "deals/comps/rent_roll.csv",
      priorPath: "deals/rent_roll/rent_roll.csv",
    });
    ok(
      "the same bytes bound to a different role refuse a second binding",
      !crossRole.ok && crossRole.code === "role_conflict",
      crossRole.ok ? "accepted" : crossRole.message,
    );
  }

  // ── The ledger ────────────────────────────────────────────────────
  console.log("\nthe ledger — hashes and counts, never text");
  const listingLedger = toLedger({ role: "listing", listing, bytes: listingText.length });
  const rentRollLedger = toLedger({ role: "rent_roll", file: csvRentRoll, bytes: rentRollBytes.byteLength, totalSf: 13_500 });
  const compsLedger = toLedger({ role: "comps", file: compsFile, bytes: fixtureBytes("comps.csv").byteLength, kept: 3 });
  const photoLedger = toLedger({ role: "photos", photo, bytes: jpeg.byteLength, kind: "jpeg" });

  for (const [name, entry] of Object.entries({ listingLedger, rentRollLedger, compsLedger, photoLedger })) {
    const json = JSON.stringify(entry);
    ok(`${name} has a sha256`, /"sha256":"[0-9a-f]{64}"/.test(json), json);
    for (const secret of ["Maple Court", "Example Coffee", "Sample Dental", "Demo Fitness", "123 Example Avenue", "listing.txt", "rent_roll.csv", "Shane"]) {
      ok(`${name} does not carry "${secret}"`, !json.includes(secret));
    }
  }
  eq("rent roll ledger carries the row count", (rentRollLedger as { rows: number }).rows, 4);
  eq("rent roll ledger carries total SF", (rentRollLedger as { totalSf: number }).totalSf, 13_500);
  eq("comps ledger carries the kept count", (compsLedger as { kept: number }).kept, 3);
  eq("photo ledger says what was removed", JSON.stringify((photoLedger as { removed: string[] }).removed), JSON.stringify(["APP1", "APP1", "COM"]));

  console.log(`\n${passes} passed, ${failures.length} failed`);
  if (failures.length) {
    console.error(`failed: ${failures.join(" | ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("HARNESS ERROR", err);
  process.exit(1);
});
