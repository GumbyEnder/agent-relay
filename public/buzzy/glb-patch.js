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
 *     its mesh (never an empty index list).
 *
 * Pure: bytes and JSON in, bytes out. No three.js and no page, so a plain `node` can test it
 * (scripts/test-model-paint.mjs).
 */
const MAGIC = 0x46546c67;        // "glTF"
const CHUNK_JSON = 0x4e4f534a;   // "JSON"
const CHUNK_BIN = 0x004e4942;    // "BIN\0"
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const ELEMENT_ARRAY_BUFFER = 34963;

/** A problem with the file, in words a person can read. */
export class GlbError extends Error {}

export const copyOf = (v) => JSON.parse(JSON.stringify(v));
const align4 = (n) => (n + 3) & ~3;

/** True when the bytes begin like a binary glTF. */
export function isGlb(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  return b.length >= 12 && new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true) === MAGIC;
}

/** A .glb as { json, bin }. */
export function readGlb(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!isGlb(bytes)) throw new GlbError("That is not a .glb file. The painter changes .glb models.");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(4, true) !== 2) throw new GlbError("That .glb is not glTF version 2.");
  const total = Math.min(dv.getUint32(8, true), bytes.length);
  let at = 12, json = null, bin = null;
  while (at + 8 <= total) {
    const len = dv.getUint32(at, true), type = dv.getUint32(at + 4, true);
    const start = at + 8;
    if (start + len > total) throw new GlbError("That .glb is cut short.");
    if (type === CHUNK_JSON && !json) {
      try { json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + len))); }
      catch { throw new GlbError("That .glb's description could not be read."); }
    } else if (type === CHUNK_BIN && !bin) bin = bytes.slice(start, start + len);
    at = start + len;
  }
  if (!json || typeof json !== "object") throw new GlbError("That .glb has no description in it.");
  return { json, bin: bin || new Uint8Array(0) };
}

/**
 * A model file as { json, bin }: a .glb, or a .gltf whose data is all inside it (data: addresses),
 * which is packed into one binary part as a .glb keeps it. A .gltf that points at other files cannot
 * be opened from one file, and says so.
 */
export function readModel(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (isGlb(bytes)) return readGlb(bytes);
  let json = null;
  try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* said below */ }
  if (!json || typeof json !== "object" || !json.asset) throw new GlbError("That is not a .glb or .gltf file. The painter changes .glb and .gltf models.");
  return packGltf(json);
}
function packGltf(json) {
  const chunks = [];
  let size = 0;
  const add = (bytes) => {
    const at = align4(size);
    if (at > size) chunks.push(new Uint8Array(at - size));
    chunks.push(bytes);
    size = at + bytes.length;
    return at;
  };
  const inside = (uri) => {
    const m = /^data:([^;,]*)(?:;[^,]*)?;base64,([\s\S]*)$/.exec(String(uri || ""));
    if (!m) throw new GlbError("This .gltf keeps part of its data in other files, so the painter cannot open it from one file. Save it as a .glb first.");
    const raw = atob(m[2]);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return { bytes: out, type: m[1] };
  };
  const base = (json.buffers || []).map((b) => add(inside(b.uri).bytes));
  (json.bufferViews || []).forEach((v) => { v.byteOffset = (v.byteOffset || 0) + base[v.buffer]; v.buffer = 0; });
  (json.images || []).forEach((im) => {
    if (im.uri === undefined) return;
    const { bytes, type } = inside(im.uri);
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

/** { json, bin } as the bytes of a .glb. */
export function writeGlb(json, bin) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = align4(jsonBytes.length);
  const binLen = align4(bin.length);
  const total = 12 + 8 + jsonLen + (bin.length ? 8 + binLen : 0);
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
  return out;
}

/** A patch on top of one .glb. Nothing is changed in place until bytes() is asked for. */
export class GlbPatch {
  constructor(glb) {
    this.json = copyOf(glb.json);
    if (this.json.buffers && this.json.buffers[0] && this.json.buffers[0].uri) {
      throw new GlbError("This .glb keeps its data outside the file, so the painter cannot change it.");
    }
    this.chunks = [glb.bin];
    this.size = glb.bin.length;
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
    return writeGlb(this.json, bin);
  }
}
