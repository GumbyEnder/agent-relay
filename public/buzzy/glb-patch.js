/*
 * Changing a .glb without rewriting it.
 *
 * The 3D painter (model-paint.js) used to load a model into three.js and export the whole
 * scene again. That re-encodes every texture (a JPEG goes through a canvas and comes out a
 * little different), forgets animations, and can only change a mesh by changing the mesh
 * itself, so a second node that reused the same geometry changed with it. A change to the
 * painted parts must leave everything else exactly as it was. So the saved file is the
 * ORIGINAL file with a small patch on top:
 *
 *   - everything that is not painted (nodes, meshes, materials, textures, animations, skins,
 *     extensions, every byte of every untouched image) is carried over untouched;
 *   - the painted faces of a primitive are moved to a primitive of their own (a new index
 *     list over the same vertices), with their own material and, when a texture is edited,
 *     their own copy of that texture. Faces that share texels with them keep the original;
 *   - a node that shares its mesh with other nodes gets a mesh of its own first, so the
 *     others do not change;
 *   - a primitive with no faces left is taken out, and a node with no primitives left loses
 *     its mesh (never an empty index list);
 *   - chunks this file does not know (a .glb may carry application chunks after its binary part)
 *     are written back byte for byte.
 *
 * Nothing is fetched from outside. A model whose pictures or data live at another address (an
 * http: or relative uri) is refused by readModel() BEFORE anything opens it: the loader would
 * contact that address, and a saved copy of the model could not hold what it points at.
 *
 * Pure: bytes and JSON in, bytes out. No three.js and no page, so a plain `node` can test it
 * (scripts/test-model-paint.mjs).
 */
const MAGIC = 0x46546c67;        // "glTF"
const CHUNK_JSON = 0x4e4f534a;   // "JSON"
const CHUNK_BIN = 0x004e4942;    // "BIN\0"
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const FLOAT = 5126;
const ELEMENT_ARRAY_BUFFER = 34963;
const ARRAY_BUFFER = 34962;

/** A problem with the file, in words a person can read. */
export class GlbError extends Error {}

export const copyOf = (v) => JSON.parse(JSON.stringify(v));
const align4 = (n) => (n + 3) & ~3;

/** True when the bytes begin like a binary glTF. */
export function isGlb(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  return b.length >= 12 && new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true) === MAGIC;
}

// A viewer takes the LAST description and binary part when a file has several; this reads the first. A file with more than one of
// either could show the check one model and the loader another (and the loader could then fetch what was never checked).
const AMBIGUOUS = "That .glb has more than one description or binary part in it, so it is not clear which one a viewer would open. " +
  "Save it again as one clean .glb.";

/** A .glb as { json, bin, extra }: extra holds any chunk that is neither the description nor the binary part. */
export function readGlb(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!isGlb(bytes)) throw new GlbError("That is not a .glb file. The painter changes .glb models.");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(4, true) !== 2) throw new GlbError("That .glb is not glTF version 2.");
  const total = Math.min(dv.getUint32(8, true), bytes.length);
  let at = 12, json = null, bin = null;
  const extra = [];
  while (at + 8 <= total) {
    const len = dv.getUint32(at, true), type = dv.getUint32(at + 4, true);
    const start = at + 8;
    if (start + len > total) throw new GlbError("That .glb is cut short.");
    if (type === CHUNK_JSON) {
      if (json) throw new GlbError(AMBIGUOUS);
      try { json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + len))); }
      catch { throw new GlbError("That .glb's description could not be read."); }
    } else if (type === CHUNK_BIN) {
      if (bin) throw new GlbError(AMBIGUOUS);
      bin = bytes.slice(start, start + len);
    } else extra.push({ type, bytes: bytes.slice(start, start + len) });
    at = start + len;
  }
  if (!json || typeof json !== "object") throw new GlbError("That .glb has no description in it.");
  return { json, bin: bin || new Uint8Array(0), extra };
}

const OUTSIDE = "This model keeps part of what it is made of (a picture or a data file) at another address or in another file, " +
  "so the painter will not open it: nothing is fetched from outside BeeZilla. Save it as one .glb with everything inside it.";

/**
 * A model file as { json, bin, extra }: a .glb, or a .gltf whose data is all inside it (data: addresses),
 * packed into one binary part the way a .glb keeps it. Anything that is not inside the file (a picture or a
 * buffer at an http: or relative address, whichever the file type) is refused here, before anything loads it.
 */
export function readModel(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (isGlb(bytes)) {
    const g = readGlb(bytes);
    return inside(g.json) ? g : { ...pack(g.json, g.bin), extra: g.extra };
  }
  let json = null;
  try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* said below */ }
  if (!json || typeof json !== "object" || !json.asset) throw new GlbError("That is not a .glb or .gltf file. The painter changes .glb and .gltf models.");
  return { ...pack(json, null), extra: [] };
}
/** True when nothing in the description has an address of its own: the pictures and data are the file's. */
function inside(json) {
  // Only the first buffer may have no address (it is the .glb's own binary part); any other has one, and it is not inside.
  return (json.buffers || []).every((b, i) => b.uri === undefined && i === 0) && (json.images || []).every((im) => im.uri === undefined);
}
function pack(json, bin0) {
  const chunks = [];
  let size = 0;
  const add = (bytes) => {
    const at = align4(size);
    if (at > size) chunks.push(new Uint8Array(at - size));
    chunks.push(bytes);
    size = at + bytes.length;
    return at;
  };
  const embedded = (uri) => {
    const m = /^data:([^;,]*)(?:;[^,]*)?;base64,([\s\S]*)$/i.exec(String(uri || ""));
    if (!m) throw new GlbError(OUTSIDE);
    const raw = atob(m[2]);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return { bytes: out, type: m[1] };
  };
  // Checked in full before anything is read: a refused file is refused whole.
  (json.buffers || []).forEach((b, i) => { if (b.uri === undefined ? !(i === 0 && bin0) : !/^data:/i.test(String(b.uri))) throw new GlbError(OUTSIDE); });
  (json.images || []).forEach((im) => { if (im.uri !== undefined && !/^data:/i.test(String(im.uri))) throw new GlbError(OUTSIDE); });
  const base = (json.buffers || []).map((b) => (b.uri === undefined ? add(bin0) : add(embedded(b.uri).bytes)));
  (json.bufferViews || []).forEach((v) => { v.byteOffset = (v.byteOffset || 0) + base[v.buffer]; v.buffer = 0; });
  (json.images || []).forEach((im) => {
    if (im.uri === undefined) return;
    const { bytes, type } = embedded(im.uri);
    if (!json.bufferViews) json.bufferViews = [];
    im.bufferView = json.bufferViews.push({ buffer: 0, byteOffset: add(bytes), byteLength: bytes.length }) - 1;
    if (!im.mimeType && type) im.mimeType = type;
    delete im.uri;
  });
  const bin = new Uint8Array(align4(size));
  let at = 0;
  for (const c of chunks) { bin.set(c, at); at += c.length; }
  json.buffers = bin.length ? [{ byteLength: bin.length }] : [];
  if (!bin.length) delete json.buffers;
  return { json, bin };
}

/** { json, bin } as the bytes of a .glb; chunks that were in the file besides those two follow, as they were. */
export function writeGlb(json, bin, extra = []) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = align4(jsonBytes.length);
  const binLen = align4(bin.length);
  const total = 12 + 8 + jsonLen + (bin.length ? 8 + binLen : 0) + extra.reduce((n, c) => n + 8 + c.bytes.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen);          // the JSON chunk is padded with spaces
  if (bin.length) {
    const at = 20 + jsonLen;
    dv.setUint32(at, binLen, true);
    dv.setUint32(at + 4, CHUNK_BIN, true);
    out.set(bin, at + 8);                                       // …the binary chunk with zeros
  }
  let end = 20 + jsonLen + (bin.length ? 8 + binLen : 0);
  for (const c of extra) {
    dv.setUint32(end, c.bytes.length, true);
    dv.setUint32(end + 4, c.type, true);
    out.set(c.bytes, end + 8);
    end += 8 + c.bytes.length;
  }
  return out;
}

/** A patch on top of one .glb. Nothing is changed in place until bytes() is asked for. */
export class GlbPatch {
  constructor(glb) {
    this.json = copyOf(glb.json);
    if (this.json.buffers && this.json.buffers[0] && this.json.buffers[0].uri) {
      throw new GlbError(OUTSIDE);
    }
    this.chunks = [glb.bin];
    this.size = glb.bin.length;
    this.extra = glb.extra || [];
  }

  /** Append bytes to the binary part, 4-byte aligned; returns where they start. */
  _append(bytes) {
    const at = align4(this.size);
    if (at > this.size) this.chunks.push(new Uint8Array(at - this.size));
    this.chunks.push(bytes);
    this.size = at + bytes.length;
    return at;
  }
  _list(name) {
    if (!this.json[name]) this.json[name] = [];
    return this.json[name];
  }
  _bufferView(bytes, target) {
    const at = this._append(bytes);
    if (!this.json.buffers || !this.json.buffers.length) this.json.buffers = [{ byteLength: 0 }];
    const def = { buffer: 0, byteOffset: at, byteLength: bytes.length };
    if (target) def.target = target;
    return this._list("bufferViews").push(def) - 1;
  }

  /** A list of vertex numbers (three to a face) as a new index accessor. */
  addIndices(list) {
    let max = 0;
    for (let i = 0; i < list.length; i++) if (list[i] > max) max = list[i];
    const wide = max > 65534;
    const typed = wide ? Uint32Array.from(list) : Uint16Array.from(list);
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    const view = this._bufferView(bytes, ELEMENT_ARRAY_BUFFER);
    return this._list("accessors").push({ bufferView: view, componentType: wide ? UNSIGNED_INT : UNSIGNED_SHORT, count: list.length, type: "SCALAR" }) - 1;
  }
  /** Per-vertex floats (items per vertex: 4 for RGBA colours) as a new vertex accessor. */
  addVertexFloats(values, items) {
    const typed = Float32Array.from(values);
    const view = this._bufferView(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength), ARRAY_BUFFER);
    return this._list("accessors").push({ bufferView: view, componentType: FLOAT, count: typed.length / items, type: items === 4 ? "VEC4" : items === 3 ? "VEC3" : "SCALAR" }) - 1;
  }
  /** Encoded picture bytes (PNG or JPEG) as a new image. */
  addImage(bytes, mimeType, name) {
    const def = { bufferView: this._bufferView(bytes), mimeType };
    if (name) def.name = name;
    return this._list("images").push(def) - 1;
  }
  /** A texture over an image, sampled like another texture (its sampler index). */
  addTexture(source, sampler, name) {
    const def = { source };
    if (sampler !== undefined) def.sampler = sampler;
    if (name) def.name = name;
    return this._list("textures").push(def) - 1;
  }
  addMaterial(def) {
    return this._list("materials").push(def) - 1;
  }

  /** The nodes that use a mesh. */
  usersOf(meshIndex) {
    const out = [];
    (this.json.nodes || []).forEach((n, i) => { if (n.mesh === meshIndex) out.push(i); });
    return out;
  }
  /**
   * Make the node's mesh exactly `prims` (primitive definitions). A mesh other nodes also use is
   * copied first, so only this node changes. No primitives: the node simply has no mesh any more
   * (a mesh may not be empty, and an empty index list is never written).
   */
  setNodePrimitives(nodeIndex, prims) {
    const node = this.json.nodes[nodeIndex];
    const meshIndex = node.mesh;
    if (!prims.length) {
      delete node.mesh; delete node.skin; delete node.weights;
      // Morph weights cannot be animated on a node that has no mesh; its other animations are left alone.
      if (this.json.animations) {
        this.json.animations.forEach((a) => { a.channels = a.channels.filter((c) => !(c.target && c.target.node === nodeIndex && c.target.path === "weights")); });
        this.json.animations = this.json.animations.filter((a) => a.channels.length);
        if (!this.json.animations.length) delete this.json.animations;
      }
      return;
    }
    if (this.usersOf(meshIndex).length > 1) {
      const own = copyOf(this.json.meshes[meshIndex]);
      own.primitives = prims;
      node.mesh = this.json.meshes.push(own) - 1;
    } else {
      this.json.meshes[meshIndex].primitives = prims;
    }
  }

  /** The patched file. */
  bytes() {
    const bin = new Uint8Array(align4(this.size));
    let at = 0;
    for (const c of this.chunks) { bin.set(c, at); at += c.length; }
    if (bin.length) {
      if (!this.json.buffers || !this.json.buffers.length) this.json.buffers = [{ byteLength: 0 }];
      this.json.buffers[0].byteLength = bin.length;
    }
    return writeGlb(this.json, bin, this.extra);
  }
}
