/**
 * CR-9 — input hygiene: what a file actually is, and what it carries.
 *
 * Two jobs, both of them about not trusting an upload:
 *
 *   1. `sniffKind` reads the magic bytes. A `.png` that is really a ZIP is
 *      accepted by every extension check ever written, so the extension is
 *      metadata and the bytes are the fact.
 *   2. `stripImageMetadata` removes the metadata segments from JPEG and PNG.
 *      A phone photo of a strip centre carries GPS, a device serial and often
 *      the photographer's name. None of that belongs in a lender's memo, in a
 *      support log or in the Library, so it is removed BEFORE the bytes are
 *      hashed and stored — the sha256 then describes exactly what is stored,
 *      and a "same file" hit cannot smuggle the unstripped original back in.
 *
 * Honest limits, stated rather than implied: JPEG EXIF/XMP (APP1), IPTC/Photoshop
 * (APP13) and comment segments are dropped whole, ICC colour profiles (APP2) are
 * KEPT because removing them changes how the photo renders. PNG eXIf/tEXt/iTXt/
 * zTXt/tIME are dropped; any other ancillary chunk is left alone. HEIC and TIFF
 * are NOT scrubbed by this file — the intake refuses them today rather than
 * storing a photo whose metadata we did not remove.
 */

import { createHash } from "node:crypto";

export type SniffedKind = "jpeg" | "png" | "pdf" | "zip" | "csv" | "text" | "unknown";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

export function sniffKind(bytes: Uint8Array): SniffedKind {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return "pdf"; // %PDF
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) return "zip"; // xlsx/docx
  // Text: no NUL bytes in the first 512 and nothing exotic.
  const probe = bytes.subarray(0, Math.min(512, bytes.length));
  let printable = 0;
  for (const b of probe) {
    if (b === 0) return "unknown";
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 160) printable++;
  }
  if (probe.length && printable / probe.length > 0.95) {
    const head = Buffer.from(probe).toString("utf8");
    return head.includes(",") && head.includes("\n") ? "csv" : "text";
  }
  return "unknown";
}

export interface StripResult {
  bytes: Uint8Array;
  kind: SniffedKind;
  /** Segment/chunk names that were removed, e.g. ["APP1"] or ["eXIf", "tEXt"]. */
  removed: string[];
  /** True when at least one metadata carrier was removed. */
  changed: boolean;
}

/** JPEG: drop APP1 (EXIF/XMP), APP13 (IPTC) and COM; stop copying after SOS. */
function stripJpeg(bytes: Uint8Array): StripResult {
  const out: number[] = [0xff, 0xd8];
  const removed: string[] = [];
  let i = 2;

  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) {
      // Not a marker where a marker must be: the file is malformed. Refuse to
      // half-strip it — storing bytes whose structure we do not understand is
      // how metadata survives a "scrub".
      throw new Error("JPEG_STRUCTURE unexpected byte where a marker was expected");
    }
    const marker = bytes[i + 1]!;
    // Standalone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      out.push(0xff, marker);
      i += 2;
      if (marker === 0xd9) break;
      continue;
    }
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (length < 2) throw new Error("JPEG_STRUCTURE segment length is impossible");
    const end = i + 2 + length;
    if (end > bytes.length) throw new Error("JPEG_STRUCTURE segment runs past end of file");
    const drop =
      marker === 0xe1 || // EXIF / XMP
      marker === 0xed || // IPTC / Photoshop
      marker === 0xfe; // comment
    if (drop) {
      const name = marker === 0xe1 ? "APP1" : marker === 0xed ? "APP13" : "COM";
      removed.push(name);
    } else {
      for (let k = i; k < end; k++) out.push(bytes[k]!);
    }
    i = end;
    if (marker === 0xda) {
      // Start of scan: entropy-coded data runs to the end of the image.
      for (let k = i; k < bytes.length; k++) out.push(bytes[k]!);
      break;
    }
  }

  return { bytes: new Uint8Array(out), kind: "jpeg", removed, changed: removed.length > 0 };
}

const PNG_DROP = new Set(["eXIf", "tEXt", "iTXt", "zTXt", "tIME"]);

/** PNG: drop the metadata chunks, copy every other chunk byte for byte (CRC included). */
function stripPng(bytes: Uint8Array): StripResult {
  const out: number[] = Array.from(bytes.subarray(0, 8));
  const removed: string[] = [];
  let i = 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  while (i + 8 <= bytes.length) {
    const length = view.getUint32(i);
    const type = Buffer.from(bytes.subarray(i + 4, i + 8)).toString("latin1");
    const end = i + 12 + length;
    if (end > bytes.length) throw new Error("PNG_STRUCTURE chunk runs past end of file");
    if (PNG_DROP.has(type)) removed.push(type);
    else for (let k = i; k < end; k++) out.push(bytes[k]!);
    i = end;
    if (type === "IEND") break;
  }

  return { bytes: new Uint8Array(out), kind: "png", removed, changed: removed.length > 0 };
}

export function stripImageMetadata(bytes: Uint8Array): StripResult {
  const kind = sniffKind(bytes);
  if (kind === "jpeg") return stripJpeg(bytes);
  if (kind === "png") return stripPng(bytes);
  return { bytes, kind, removed: [], changed: false };
}

/** Cheap, non-cryptographic fingerprint of what is in an image's metadata. */
export function metadataHints(bytes: Uint8Array): string[] {
  const hints: string[] = [];
  const haystack = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 200_000))).toString("latin1");
  if (/Exif\0\0/.test(haystack)) hints.push("exif");
  if (/GPS/i.test(haystack)) hints.push("gps");
  if (/http:\/\/ns\.adobe\.com\/xap\/1\.0\//.test(haystack)) hints.push("xmp");
  if (/Photoshop 3\.0/.test(haystack)) hints.push("iptc");
  return hints;
}
