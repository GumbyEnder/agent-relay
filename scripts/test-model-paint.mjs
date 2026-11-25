// The 3D painter's reading of what people ask, its recolouring (public/buzzy/model-paint.js) and its
// patching of a .glb (public/buzzy/glb-patch.js). What it must never do: guess a change the words
// don't ask for, touch a pixel outside the paint, or touch a node, mesh, image or animation that was
// not painted. The browser probes (probe-model-paint.mjs, probe-paint-on-board.mjs) check the rest.
//   node scripts/test-model-paint.mjs
import { readInstruction, describeInstruction, recolourPixels, fillChannel, REGIONS } from "../public/buzzy/model-paint.js";
import { GlbError, GlbPatch, copyOf, isGlb, readGlb, readModel, writeGlb } from "../public/buzzy/glb-patch.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail ? " — " + detail : "")); } };
const kinds = (list) => list.map((t) => readInstruction(t).kind);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("What an instruction asks for");
ok("red and blue brushes", REGIONS.map((r) => r.key).join() === "red,blue");
ok("see-through / glass → glass", ["make it see-through", "glass please", "the windshield should be tinted", "transparent", "turn it into see-through glass", "make it glass"].every((t) => readInstruction(t).kind === "glass"), kinds(["make it see-through", "glass please", "the windshield should be tinted", "transparent"]).join());
ok("clear glass is clearer than tinted", readInstruction("make it clear glass").opacity < readInstruction("tinted dark glass").opacity);
ok("a coloured glass keeps its colour", readInstruction("blue tinted glass").colour === "#1e5bd8");
ok("remove / delete / get rid of, said about the part itself → remove", ["remove it", "delete this part", "get rid of it", "take it off", "cut it off", "hide it", "remove", "remove the red area", "please remove it", "I want you to delete this part", "get rid of the painted area", "delete the part I painted", "take this away"].every((t) => readInstruction(t).kind === "remove"), kinds(["remove it", "delete this part", "get rid of it", "take it off"]).join());
ok("“remove the scratches” is a repaint, never a deletion of faces", readInstruction("remove the scratches").kind === "repaint");
ok("a named thing is not the part itself: nothing is deleted on a guess", ["get rid of the antenna", "delete the dirt", "remove the paint", "hide the logo", "remove the glass", "take off the rust"].every((t) => readInstruction(t).kind === "repaint"), kinds(["get rid of the antenna", "delete the dirt", "remove the paint", "hide the logo"]).join());
ok("“make the windshield opaque” is not glass: it makes the part solid", (() => { const r = readInstruction("make the windshield opaque"); return r.kind === "look" && r.opaque === true && !r.colour; })());
ok("“not see-through”, “not transparent”, “solid” all say opaque", ["make it not see-through", "make it not transparent", "make it solid", "non-transparent", "no longer see through"].every((t) => { const r = readInstruction(t); return r.kind === "look" && r.opaque === true; }));
ok("words about glass that are not a request for glass go to the picture maker", ["clean the glass", "add cracks to the glass", "fix the windshield", "make the glass dirty", "clear the scratches"].every((t) => readInstruction(t).kind === "repaint"), kinds(["clean the glass", "add cracks to the glass", "fix the windshield"]).join());
ok("a part's name on its own is harmless: “make the windshield black” recolours", (() => { const r = readInstruction("make the windshield black"); return r.kind === "look" && r.colour === "#111111"; })());
ok("“the red area” names the area, it is not the colour red", (() => { const r = readInstruction("make the red area black"); return r.kind === "look" && r.colour === "#111111"; })());
ok("a colour alone → look with that colour", (() => { const r = readInstruction("make it black"); return r.kind === "look" && r.colour === "#111111"; })());
ok("two colours at once are not guessed", readInstruction("make it red and blue").kind === "repaint");
ok("dark / light shades a colour", readInstruction("dark green").colour !== readInstruction("green").colour);
ok("a hex colour is read exactly", readInstruction("make it #ff8800").colour === "#ff8800" && readInstruction("#f80").colour === "#ff8800");
ok("shiny metal → low roughness, metal", (() => { const r = readInstruction("make it shiny metal"); return r.kind === "look" && r.roughness < 0.3 && r.metalness > 0.5; })());
ok("shiny alone is a finish, not metal", (() => { const r = readInstruction("make it shiny"); return r.kind === "look" && r.roughness < 0.3 && r.metalness === null; })());
ok("a colour and a finish are one change", (() => { const r = readInstruction("make it black, shiny metal"); return r.kind === "look" && r.colour === "#111111" && r.metalness > 0.5 && r.roughness < 0.3; })());
ok("matte → rough", readInstruction("make it matte").roughness > 0.8);
ok("anything else goes to the picture maker, words kept", (() => { const r = readInstruction("add rust stains and bullet scratches"); return r.kind === "repaint" && /rust stains/.test(r.words); })());
ok("a colour plus something to draw is a repaint, not a recolour", readInstruction("make it red with a white star").kind === "repaint");
ok("nothing said → nothing done", readInstruction("   ").kind === "none" && readInstruction("make it").kind === "none" && readInstruction("please").kind === "none");
ok("what an instruction will do is said in words", describeInstruction(readInstruction("remove it")) !== "" && /black/.test(describeInstruction(readInstruction("make it black"))) && /see-through/.test(describeInstruction(readInstruction("glass"))) && /picture maker/.test(describeInstruction(readInstruction("add rust"))));

console.log("\nRecolour");
const w = 4, h = 1;
const px = new Uint8ClampedArray([200, 0, 0, 255, 100, 0, 0, 255, 0, 160, 0, 255, 0, 80, 0, 255]);
const before = px.slice();
const mask = new Uint8ClampedArray([255, 255, 0, 0]);
const n = recolourPixels(px, mask, "#0000ff");
ok("recolours exactly the masked pixels", n === 2);
ok("unmasked pixels are byte-for-byte the same", px.slice(8).every((v, i) => v === before[8 + i]));
ok("masked pixels take the colour", px[2] > 150 && px[6] > 60 && px[0] < 10 && px[4] < 10);
ok("…and keep their light and shade (the brighter stays brighter)", px[2] > px[6]);
ok("alpha is left alone", px[3] === 255 && px[7] === 255);
ok("an empty mask changes nothing", recolourPixels(before.slice(), new Uint8ClampedArray(w * h), "#ffffff") === 0);
{
  // A flat black area has no shade to keep: it simply takes the colour (it used to stay black).
  const black = new Uint8ClampedArray(16).fill(0);
  for (let i = 3; i < 16; i += 4) black[i] = 255;
  recolourPixels(black, new Uint8ClampedArray([255, 255, 0, 0]), "#ff0000");
  ok("a flat black area takes a new colour", black[0] === 255 && black[1] === 0 && black[2] === 0 && black[4] === 255 && black[8] === 0 && black[12] === 0, Array.from(black).join());
  const dark = new Uint8ClampedArray([2, 2, 2, 255, 2, 2, 2, 255]);
  recolourPixels(dark, new Uint8ClampedArray([255, 255]), "#00ff00");
  ok("a nearly black area takes it too", dark[1] === 255 && dark[0] === 0 && dark[5] === 255);
  const ch = new Uint8ClampedArray([10, 20, 30, 255, 10, 20, 30, 255]);
  fillChannel(ch, new Uint8ClampedArray([255, 0]), 1, 255);
  ok("one channel of the masked pixels can be set, the rest left", ch[1] === 255 && ch[0] === 10 && ch[2] === 30 && ch[5] === 20);
}

console.log("\nPatching a .glb");
// A small model, by hand: one quad (two faces) used by two nodes (one mesh, shared), a second mesh with
// two primitives, an animation, and a picture whose bytes must come out exactly as they went in.
function buildGlb() {
  const chunks = [];
  let size = 0;
  const add = (bytes) => { const at = size; chunks.push(bytes); size += bytes.length; while (size % 4) { chunks.push(new Uint8Array(1)); size++; } return at; };
  const f32 = (a) => new Uint8Array(Float32Array.from(a).buffer);
  const u16 = (a) => new Uint8Array(Uint16Array.from(a).buffer);
  const pos = f32([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
  const idx = u16([0, 1, 2, 2, 1, 3]);
  const times = f32([0, 1]);
  const values = f32([0, 0, 0, 1, 0, 0, 0, 1]);
  const image = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0xff, 0xd9]);     // “a JPEG”
  const json = {
    asset: { version: "2.0" },
    scene: 0, scenes: [{ nodes: [0, 1, 2] }],
    nodes: [{ name: "left wheel", mesh: 0, translation: [-1, 0, 0] }, { name: "right wheel", mesh: 0, translation: [1, 0, 0] }, { name: "body", mesh: 1 }],
    meshes: [
      { name: "wheel", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] },
      { name: "body", primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 1 }, { attributes: { POSITION: 0 }, indices: 1, material: 0, mode: 4 }] },
    ],
    materials: [{ name: "rubber", pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }, { name: "paint" }],
    textures: [{ source: 0, sampler: 0 }], samplers: [{ magFilter: 9729 }],
    images: [{ bufferView: 4, mimeType: "image/jpeg" }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 6, type: "SCALAR" },
      { bufferView: 2, componentType: 5126, count: 2, type: "SCALAR", min: [0], max: [1] },
      { bufferView: 3, componentType: 5126, count: 2, type: "VEC3" },
    ],
    animations: [{ name: "roll", channels: [{ sampler: 0, target: { node: 0, path: "translation" } }], samplers: [{ input: 2, output: 3 }] }],
  };
  const views = [pos, idx, times, values, image].map((b) => ({ buffer: 0, byteOffset: add(b), byteLength: b.length }));
  json.bufferViews = views;
  const bin = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bin.set(c, at); at += c.length; }
  json.buffers = [{ byteLength: size }];
  return { json, bin, image };
}
const base = buildGlb();
const bytes = writeGlb(base.json, base.bin);
ok("a .glb is recognised, and read back as it was written", isGlb(bytes) && bytes.length % 4 === 0 && same(readGlb(bytes).json, base.json) && same(Array.from(readGlb(bytes).bin), Array.from(base.bin)));
ok("bytes that are not a .glb say so in words", (() => { try { readGlb(new Uint8Array([123, 34, 97, 34, 58, 49, 125, 0, 0, 0, 0, 0, 0])); return false; } catch (e) { return e instanceof GlbError && /not a \.glb/.test(e.message); } })());
ok("a .glb whose data lives outside the file is refused, not half-changed", (() => { try { new GlbPatch({ json: { buffers: [{ uri: "model.bin", byteLength: 4 }] }, bin: new Uint8Array(0) }); return false; } catch (e) { return e instanceof GlbError; } })());

{
  // The left wheel's second face is painted and made glass; the right wheel (the same mesh) is not.
  const patch = new GlbPatch(readGlb(bytes));
  const j = patch.json;
  const prim = j.meshes[0].primitives[0];
  const keep = patch.addIndices([0, 1, 2]);
  const glass = patch.addIndices([2, 1, 3]);
  const glassMat = patch.addMaterial({ name: "glass", alphaMode: "BLEND", doubleSided: true });
  patch.setNodePrimitives(0, [{ ...copyOf(prim), indices: keep }, { ...copyOf(prim), indices: glass, material: glassMat }]);
  const out = readGlb(patch.bytes());
  const o = out.json;
  ok("a node that shares its mesh gets a mesh of its own; the other node keeps the original", o.nodes[0].mesh === 2 && o.nodes[1].mesh === 0 && o.meshes.length === 3);
  ok("the shared mesh is exactly as it was", same(o.meshes[0], base.json.meshes[0]));
  ok("the node's own mesh has its two primitives: the kept faces and the changed ones", o.meshes[2].primitives.length === 2 && o.meshes[2].primitives[1].material === glassMat && o.meshes[2].name === "wheel");
  ok("everything not painted is untouched: other meshes, nodes, animations, samplers, images, textures", same(o.meshes[1], base.json.meshes[1]) && same(o.animations, base.json.animations) && same(o.samplers, base.json.samplers) && same(o.textures, base.json.textures) && same(o.images, base.json.images) && same(o.nodes[1], base.json.nodes[1]) && same(o.nodes[2], base.json.nodes[2]) && same(o.nodes[0].translation, [-1, 0, 0]));
  const at = o.bufferViews[o.images[0].bufferView];
  ok("an untouched picture comes out byte for byte", same(Array.from(out.bin.subarray(at.byteOffset, at.byteOffset + at.byteLength)), Array.from(base.image)));
  ok("every original piece of data is still where it was", base.json.bufferViews.every((v, i) => same(o.bufferViews[i], v)));
  ok("the new indices are valid (aligned, inside the data, no empty list)", o.accessors.slice(4).every((a) => a.count > 0 && o.bufferViews[a.bufferView].byteOffset % 4 === 0 && o.bufferViews[a.bufferView].byteOffset + o.bufferViews[a.bufferView].byteLength <= out.bin.length) && o.buffers[0].byteLength === out.bin.length);
  ok("the new indices hold exactly the faces they were given", (() => {
    const a = o.accessors[o.meshes[2].primitives[1].indices];
    const v = o.bufferViews[a.bufferView];
    return a.componentType === 5123 && same(Array.from(new Uint16Array(out.bin.buffer, out.bin.byteOffset + v.byteOffset, a.count)), [2, 1, 3]);
  })());
}
{
  // Every face of the body's first primitive is removed: the primitive goes; the mesh stays for its other primitive.
  const patch = new GlbPatch(readGlb(bytes));
  const keepSecond = copyOf(patch.json.meshes[1].primitives[1]);
  patch.setNodePrimitives(2, [keepSecond]);
  const o = readGlb(patch.bytes()).json;
  ok("a primitive with no faces left is taken out (never an empty index list)", o.meshes[1].primitives.length === 1 && o.meshes[1].primitives[0].material === 0 && !o.accessors.some((a) => a.count === 0));
}
{
  // Everything of a node is removed: it simply has no mesh any more.
  const patch = new GlbPatch(readGlb(bytes));
  patch.setNodePrimitives(2, []);
  const o = readGlb(patch.bytes()).json;
  ok("a node with nothing left loses its mesh, and nothing else changes", o.nodes[2].mesh === undefined && o.nodes[2].name === "body" && same(o.meshes, base.json.meshes) && same(o.animations, base.json.animations));
}
{
  // A new picture (a texture copy) is a new image with a texture sampled like the old one; the old stay.
  const patch = new GlbPatch(readGlb(bytes));
  const img = patch.addImage(new Uint8Array([1, 2, 3, 4, 5]), "image/png", "copy");
  const tex = patch.addTexture(img, 0, "copy");
  const o = readGlb(patch.bytes());
  ok("a texture copy is added beside the original, with the same sampler", tex === 1 && img === 1 && o.json.textures[1].sampler === 0 && o.json.textures[0].source === 0 && o.json.images[1].mimeType === "image/png" && o.json.bufferViews[o.json.images[1].bufferView].byteLength === 5);
  ok("…and the original picture is still the same bytes", (() => { const v = o.json.bufferViews[o.json.images[0].bufferView]; return same(Array.from(o.bin.subarray(v.byteOffset, v.byteOffset + v.byteLength)), Array.from(base.image)); })());
  const big = new GlbPatch(readGlb(bytes));
  const wide = big.addIndices([0, 1, 70000]);
  ok("indices that need 32 bits get them", big.json.accessors[wide].componentType === 5125);
}

{
  // A node that loses its mesh loses the morph-weight animation that had nothing left to move, and no other.
  const j = copyOf(base.json);
  j.animations.push({ name: "morph", channels: [{ sampler: 0, target: { node: 2, path: "weights" } }], samplers: [{ input: 2, output: 2 }] });
  const patch = new GlbPatch({ json: j, bin: base.bin });
  patch.setNodePrimitives(2, []);
  ok("a node that loses its mesh loses its morph-weight animation, and no other animation changes", patch.json.animations.length === 1 && patch.json.animations[0].name === "roll" && same(patch.json.animations[0], base.json.animations[0]));
}

console.log("\nA .gltf with its data inside");
{
  const b64 = (u8) => Buffer.from(u8).toString("base64");
  const gj = copyOf(base.json);
  gj.buffers = [{ byteLength: base.bin.length, uri: "data:application/octet-stream;base64," + b64(base.bin) }];
  gj.images = [{ uri: "data:image/jpeg;base64," + b64(base.image) }];
  const m = readModel(new TextEncoder().encode(JSON.stringify(gj)));
  ok("it is packed the way a .glb is: one binary part, every piece of data in it", m.json.buffers.length === 1 && m.json.bufferViews.every((v) => v.buffer === 0 && v.byteOffset + v.byteLength <= m.bin.length));
  ok("…every piece of data is still the same bytes", same(Array.from(m.bin.subarray(m.json.bufferViews[0].byteOffset, m.json.bufferViews[0].byteOffset + m.json.bufferViews[0].byteLength)), Array.from(base.bin.subarray(0, 48))));
  ok("…and a picture that was an address is a piece of the binary part, with its type and the same bytes", (() => { const im = m.json.images[0]; const v = m.json.bufferViews[im.bufferView]; return im.uri === undefined && im.mimeType === "image/jpeg" && same(Array.from(m.bin.subarray(v.byteOffset, v.byteOffset + v.byteLength)), Array.from(base.image)); })());
  ok("…and it patches like any .glb", (() => { const p = new GlbPatch(m); p.setNodePrimitives(2, []); const o = readGlb(p.bytes()).json; return o.nodes[2].mesh === undefined && same(o.meshes, base.json.meshes); })());
  ok("a .glb is read as it is", same(readModel(bytes).json, base.json));
  const outside = copyOf(base.json);
  outside.buffers = [{ byteLength: 8, uri: "model.bin" }];
  ok("a .gltf that keeps its data in other files says so, in words", (() => { try { readModel(new TextEncoder().encode(JSON.stringify(outside))); return false; } catch (e) { return e instanceof GlbError && /other files/.test(e.message); } })());
  ok("text that is not a model says so too", (() => { try { readModel(new TextEncoder().encode("hello")); return false; } catch (e) { return e instanceof GlbError && /not a \.glb or \.gltf/.test(e.message); } })());
}

console.log(`\nmodel paint: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
