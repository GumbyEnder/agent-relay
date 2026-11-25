// The 3D painter's reading of what people ask, and its recolouring (public/buzzy/model-paint.js).
// What it must never do: guess a change the words don't ask for, or touch a pixel outside the
// paint. The browser probes (probe-model-paint.mjs, probe-paint-on-board.mjs) check the rest.
//   node scripts/test-model-paint.mjs
import { readInstruction, recolourPixels, REGIONS } from "../public/buzzy/model-paint.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log("  ok   " + name); } else { fail++; console.log("  FAIL " + name + (detail ? " — " + detail : "")); } };

ok("red and blue brushes", REGIONS.map((r) => r.key).join() === "red,blue");
ok("see-through / glass / windshield → glass", ["make it see-through", "glass please", "the windshield should be tinted", "transparent"].every((t) => readInstruction(t).kind === "glass"));
ok("clear glass is clearer than tinted", readInstruction("make it clear glass").opacity < readInstruction("tinted dark glass").opacity);
ok("a coloured glass keeps its colour", readInstruction("blue tinted glass").colour === "#1e5bd8");
ok("remove / delete / get rid of → remove", ["remove it", "delete this part", "get rid of the antenna", "take it off"].every((t) => readInstruction(t).kind === "remove"));
ok("a colour alone → look with that colour", (() => { const r = readInstruction("make it black"); return r.kind === "look" && r.colour === "#111111"; })());
ok("dark / light shades a colour", readInstruction("dark green").colour !== readInstruction("green").colour);
ok("a hex colour is read exactly", readInstruction("make it #ff8800").colour === "#ff8800" && readInstruction("#f80").colour === "#ff8800");
ok("shiny metal → low roughness, metal", (() => { const r = readInstruction("make it shiny metal"); return r.kind === "look" && r.roughness < 0.3 && r.metalness > 0.5; })());
ok("matte → rough", readInstruction("make it matte").roughness > 0.8);
ok("anything else goes to the picture maker, words kept", (() => { const r = readInstruction("add rust stains and bullet scratches"); return r.kind === "repaint" && /rust stains/.test(r.words); })());
ok("a colour plus something to draw is a repaint, not a recolour", readInstruction("make it red with a white star").kind === "repaint");
ok("nothing said → nothing done", readInstruction("   ").kind === "none");

// Recolour: only masked pixels change, their light and shade kept.
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

console.log(`\nmodel paint: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
