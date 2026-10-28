/**
 * Recipe Seal — Step 2: a deterministic ZIP writer/reader.
 *
 * "Deterministic" means: entries sorted by name, stored (no deflate), fixed
 * epoch timestamp, no extra fields, no comments. Sealing the same recipe twice
 * must produce byte-identical output, which is what makes the bundle hash a
 * stable identity rather than a build artefact.
 */
export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** 1980-01-01 00:00:00 in DOS format: the earliest representable timestamp. */
const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

export function makeZip(entries: ZipEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const enc = new TextEncoder();
  const locals: number[] = [];
  const centrals: number[] = [];
  let offset = 0;

  for (const entry of sorted) {
    const name = enc.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = [
      ...u32(LOCAL_SIG), ...u16(20), ...u16(0), ...u16(0),
      ...u16(DOS_TIME), ...u16(DOS_DATE),
      ...u32(crc), ...u32(size), ...u32(size),
      ...u16(name.length), ...u16(0),
      ...name, ...entry.data,
    ];
    const central = [
      ...u32(CENTRAL_SIG), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(DOS_TIME), ...u16(DOS_DATE),
      ...u32(crc), ...u32(size), ...u32(size),
      ...u16(name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0),
      ...u32(offset),
      ...name,
    ];
    centrals.push(...central);
    locals.push(...local);
    offset += local.length;
  }

  const localBytes = Uint8Array.from(locals);
  const centralBytes = Uint8Array.from(centrals);
  const eocd = Uint8Array.from([
    ...u32(EOCD_SIG), ...u16(0), ...u16(0),
    ...u16(sorted.length), ...u16(sorted.length),
    ...u32(centralBytes.length), ...u32(localBytes.length),
    ...u16(0),
  ]);

  const out = new Uint8Array(localBytes.length + centralBytes.length + eocd.length);
  out.set(localBytes, 0);
  out.set(centralBytes, localBytes.length);
  out.set(eocd, localBytes.length + centralBytes.length);
  return out;
}

export function readZip(buf: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();

  // Find the end-of-central-directory record from the tail.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip_end_of_central_directory_not_found");

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== CENTRAL_SIG) throw new Error("zip_bad_central_directory");
    const method = view.getUint16(p + 10, true);
    if (method !== 0) throw new Error("zip_compression_not_supported");
    const csize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = dec.decode(buf.slice(p + 46, p + 46 + nameLen));

    if (view.getUint32(localOffset, true) !== LOCAL_SIG) throw new Error("zip_bad_local_header");
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    out.set(name, buf.slice(dataStart, dataStart + csize));

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
