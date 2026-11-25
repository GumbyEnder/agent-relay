/**
 * Files that come out of BeeZilla's own browser: what a website downloads while BeeZilla
 * (or the person, recording) uses it — the song from a music site, a PDF, a picture.
 *
 * Owner, 2026-11-23: "go to merica.com and, you know, go to /create and then type in these
 * instructions to create the sound and then download the sound and send it elsewhere."
 *
 * A download is saved to the person's Library and served back from BeeZilla's own address
 * (/api/buzzy/assets/<id>, inline). So what a website says a file is can't be trusted: an
 * "audio file" that is really a web page would run its scripts on BeeZilla's address, signed
 * in as the person. Here every file gets a type from a short list of things that are safe to
 * show (sound, video, pictures that are not SVG, PDF, plain text, office files…), checked
 * against its first bytes, and anything else is kept as plain bytes to download.
 *
 * Also here: a name that is safe to keep, and reading one file out of a zip (the cloud
 * browser keeps the files a session downloaded as one zip).
 */
import { inflateRawSync } from "node:zlib";

/** The Library's own limit for one file (chat.nitro.ts ASSET_MAX_BYTES). */
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/** A file name a website suggested, made safe to keep and show: no folders, no control characters. */
export function safeFileName(suggested: unknown, url?: unknown): string {
  let name = String(suggested ?? "").trim();
  if (!name && url) {
    try {
      const u = new URL(String(url));
      if (u.protocol === "http:" || u.protocol === "https:") name = decodeURIComponent(u.pathname.split("/").pop() || "");
    } catch { /* no name from the address */ }
  }
  name = name
    .replace(/[\\/]+/g, "_")
    // eslint-disable-next-line no-control-regex -- deliberate: strips control bytes
    .replace(/[\u0000-\u001f\u007f"<>|*?:]/g, "")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .trim();
  if (!name) name = "download";
  if (name.length > 120) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name;
}

/** Types shown as themselves. Everything else is kept as bytes to download (application/octet-stream). */
const SAFE: Record<string, string> = {
  "audio/mpeg": "audio/mpeg", "audio/mp3": "audio/mpeg", "audio/mpeg3": "audio/mpeg", "audio/x-mpeg": "audio/mpeg",
  "audio/wav": "audio/wav", "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/vnd.wave": "audio/wav",
  "audio/ogg": "audio/ogg", "audio/opus": "audio/ogg", "audio/flac": "audio/flac", "audio/x-flac": "audio/flac",
  "audio/aac": "audio/aac", "audio/mp4": "audio/mp4", "audio/x-m4a": "audio/mp4", "audio/m4a": "audio/mp4", "audio/webm": "audio/webm",
  "video/mp4": "video/mp4", "video/webm": "video/webm", "video/quicktime": "video/quicktime", "video/ogg": "video/ogg",
  "image/png": "image/png", "image/jpeg": "image/jpeg", "image/jpg": "image/jpeg", "image/gif": "image/gif", "image/webp": "image/webp", "image/avif": "image/avif",
  "application/pdf": "application/pdf",
  "text/plain": "text/plain", "text/csv": "text/csv", "text/markdown": "text/markdown",
  "application/json": "application/json",
  "application/zip": "application/zip",
  "model/gltf-binary": "model/gltf-binary",
  "application/msword": "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/epub+zip": "application/epub+zip",
};
const BY_EXT: Record<string, string> = {
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", aac: "audio/aac", m4a: "audio/mp4",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  pdf: "application/pdf", txt: "text/plain", csv: "text/csv", md: "text/markdown", json: "application/json", zip: "application/zip",
  glb: "model/gltf-binary", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  epub: "application/epub+zip",
};
export const OCTET = "application/octet-stream";

const starts = (b: Buffer, sig: string, at = 0) => b.length >= at + sig.length && b.subarray(at, at + sig.length).toString("latin1") === sig;

/** What the first bytes say the file is, for the kinds that have a clear mark. "" when they don't say. */
export function sniff(b: Buffer): string {
  if (!b || b.length < 4) return "";
  if (starts(b, "ID3") || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x06) !== 0)) return "audio/mpeg";
  if (b[0] === 0xff && (b[1]! & 0xf6) === 0xf0) return "audio/aac";   // ADTS
  if (starts(b, "RIFF") && starts(b, "WAVE", 8)) return "audio/wav";
  if (starts(b, "RIFF") && starts(b, "WEBP", 8)) return "image/webp";
  if (starts(b, "OggS")) return "audio/ogg";
  if (starts(b, "fLaC")) return "audio/flac";
  if (starts(b, "ftyp", 4)) {
    const brand = b.subarray(8, 12).toString("latin1");
    if (/^(M4A |M4B |M4P )/.test(brand)) return "audio/mp4";
    if (/^qt {2}/.test(brand)) return "video/quicktime";
    if (/^(avif|avis)/.test(brand)) return "image/avif";
    return "video/mp4";
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (starts(b, "\x89PNG")) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (starts(b, "GIF8")) return "image/gif";
  if (starts(b, "%PDF")) return "application/pdf";
  if (starts(b, "PK\x03\x04")) return "application/zip";
  if (starts(b, "glTF")) return "model/gltf-binary";
  return "";
}

/** Text that a browser could take for a page or a picture with scripts in it. */
function looksLikeMarkup(b: Buffer): boolean {
  const head = b.subarray(0, 512).toString("utf8").replace(/^\ufeff/, "").trimStart().toLowerCase();
  return /^<(?:!doctype|html|head|body|script|svg|\?xml|iframe|object|embed|meta|div|a |img|style)/.test(head);
}

/**
 * The type a downloaded file is kept as. The first bytes win over what the website said; a
 * type that is not on the safe list, or markup of any kind, is kept as plain bytes.
 */
export function safeContentType(declared: unknown, name: string, bytes: Buffer): string {
  const said = String(declared ?? "").split(";")[0]!.trim().toLowerCase();
  const seen = sniff(bytes);
  if (seen) return SAFE[seen] ?? OCTET;
  if (looksLikeMarkup(bytes)) return OCTET;
  if (SAFE[said]) {
    // A container type claimed without its mark is not trusted: it would be shown by a player.
    if (/^(audio|video|image)\//.test(said) || said === "application/pdf" || said === "application/zip") return OCTET;
    return SAFE[said]!;
  }
  const ext = (name.split(".").pop() || "").toLowerCase();
  const byExt = BY_EXT[ext];
  if (byExt && !/^(audio|video|image)\//.test(byExt) && byExt !== "application/pdf" && byExt !== "application/zip") return byExt;
  return OCTET;
}

/** A data: address, decoded (what a page hands to a download link it made itself). */
export function decodeDataUrl(url: string): { type: string; bytes: Buffer } | null {
  const m = /^data:([^,]*?),(.*)$/s.exec(url);
  if (!m) return null;
  const meta = m[1] ?? "";
  const base64 = /;base64$/i.test(meta);
  const type = meta.replace(/;base64$/i, "").split(";")[0]!.trim() || "text/plain";
  try {
    const bytes = base64 ? Buffer.from(m[2]!, "base64") : Buffer.from(decodeURIComponent(m[2]!), "utf8");
    return { type, bytes };
  } catch {
    return null;
  }
}

/**
 * One file out of a zip, by its name (or the end of its path), or null. Stored and deflated
 * entries only (what a browser's download folder zipped up holds), and never more than the
 * download limit.
 */
export function readZipEntry(zip: Buffer, want: string): Buffer | null {
  if (!zip || zip.length < 22) return null;
  // The end-of-central-directory record is within the last 64 KB.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= zip.length; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(p + 10);
    const csize = zip.readUInt32LE(p + 20);
    const usize = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== want && !name.endsWith("/" + want)) continue;
    if (usize > MAX_DOWNLOAD_BYTES || local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) return null;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + csize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) {
      try { return inflateRawSync(data, { maxOutputLength: MAX_DOWNLOAD_BYTES }); } catch { return null; }
    }
    return null;
  }
  return null;
}

/** "3.1 MB" */
export function sizeWords(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
