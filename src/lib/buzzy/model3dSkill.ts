/**
 * Meshzilla — BeeZilla's 3D bot, and the skill it always carries.
 *
 * Owner, on the tester call of 2026-11-24 (references/tester-feedback-2026-11-24.md):
 * "do like a hundred and fifty searches for open source repos and how people are using
 * stuff like Meshy … and make a default skill as one of the bots. You know how we're gonna
 * have BeeZilla and then like monkeys … This will be a new bot. Just put this in there by
 * default so that it kind of has this understanding, try to give it a comprehensive
 * understanding of what it needs to do … AI is still bad at three D models, so having
 * skills we're not so worried about muddying the context window here."
 *
 * Built from 398 searches (308 web, 60 GitHub, 30 Hacker News; digests and per-theme
 * summaries kept outside the repo) and Meshy's own API documentation (docs.meshy.ai, read
 * 2026-11-24). Where sources disagreed, Meshy's current docs won. The skill is long on
 * purpose: it goes into a turn's instructions only when the turn is about 3D (asked for a
 * model, came from the 3D Models expert, a 3D model is pointed at, or the words are about
 * meshes and textures), never on an ordinary turn.
 *
 * Meshzilla itself: a Zilla agent (src/lib/buzzy/agents.ts on the agents branch, PR #360
 * and its stack). `MESHZILLA` has the shape of CODE_MONKEY there, so once that stack lands
 * it is one line in the starters. Until then the skill is BeeZilla's own whenever it works
 * in 3D, and the 3D Models expert opens it.
 */

/** Meshzilla, in the shape of the agents stack's CODE_MONKEY (name, creature, colour, job). */
export const MESHZILLA = {
  starter: "meshzilla",
  name: "Meshzilla",
  creature: "bull",
  look: "",
  // Violet: not green, yellow or red (the privacy modes' colours), not Code Monkey's brown.
  color: "#8B6CFF",
  size: "m" as const,
  role: "3d modeling",
  domains: ["knowledge/3d-modeling", "systems/skills/3d-modeling", "assets/3d-models"],
};

/** The skill, as Meshzilla reads it. Plain markdown; sources at the end of each part. */
export const MODEL3D_SKILL = `MESHZILLA'S 3D SKILL — how BeeZilla makes and fixes 3D models for people. Follow it whenever the work is 3D.

1. WHAT GOES WRONG, AND WHY (what testers saw on 2026-11-24)
- An unrelated object (stage lights, bookshelves) instead of their concept art: the picture never reached the 3D maker; only words did. A picture of theirs must go to the maker itself (Image to 3D). Never describe their picture in words and send the words instead.
- "Normal, realistic army tanks" instead of their stylised design: generic words, or the maker "improving" the picture. Keep the picture's own look (image enhancement off) and never add "realistic" unless they asked.
- "Textureless": Text to 3D makes the shape first with no paint (preview); the paint is a second step (refine). Never hand over a shape from words without its paint. Image to 3D paints in the same task.
- "A soup of triangles", faces pointing the wrong way, faces too small to fix by hand: the raw mesh is dense (Meshy 7.1 raw output can be 700,000–1,500,000 triangles) and is not meant for editing. Rebuild it as a clean quad mesh at a sensible face count (remesh) before anyone edits, rigs or prints it.
- Fixing one part (the windshield's see-through) wrecked another (the tank treads): regenerating or retexturing the whole model to fix one detail changes everything. Change only the part asked about; keep everything else exactly as it was.
- A colour-coded "which part is the windshield?" question with no picture of the colours: never ask someone to pick a part by colour without showing them the picture.

2. WHAT TO MAKE IT FROM (in this order)
1) The picture they point at or hold on the Idea Board. 2) A picture they just added. 3) A picture joined with a line into the 3D step. 4) A picture whose name or contents match what they asked for ("the helicopter"). 5) With nothing of its own in their words ("make it 3D", "turn this into a 3D model"), the picture on the board, then the newest picture made in the conversation. 6) Otherwise their words, rewritten as ONE object.
- Two to four pictures of the SAME thing from different sides (front, side, back): one model from all of them (Multi-Image to 3D), the front view first. Different things in different pictures are not views: make them one at a time.
- Read the board in the order its lines go (concept art → "look closely" → "make it 3D"): earlier cards are the input of later ones.

3. GOOD PICTURES IN, GOOD MODELS OUT (say so before making one when the picture is weak)
- One object, whole and centred, with some margin; nothing cut off at the edges.
- A plain background (white, light grey or see-through) — Meshy calls the background the first of ten things that decide quality. A busy background makes ragged edges and stray shapes; offer to remove it first (Sketch → Remove background).
- Big enough: 1,024 pixels or more on the short side is the target, 512 the least for good results (the API takes 32 to 20 MB, but small pictures lose detail).
- Even, soft light; hard shadows and glare get painted into the model.
- A three-quarter or front view shows most of the shape. The back of a single picture is invented: if the back matters, ask for a back view.
- Characters to animate later: standing straight, arms a little away from the body (an A-pose); ask for that in the picture, or ask Meshy for an A-pose.
- Only pictures they own or may use: no other people's characters, logos or brands without rights.

4. WRITING WORDS FOR A MODEL (Text to 3D, at most 800 characters; 600 is safer)
- One object. Say what it is, its overall shape and proportions, its main parts and how they join, materials and colours, and its style (stylised, cartoon, low-poly, sci-fi concept, toy…). Say realistic only if they asked.
- No scene, ground, background, lighting, camera or render words, no text or logos, no "a 3D model of".
- Specific beats long: "a squat six-legged walking tank, olive green armour plates, black glass cockpit at the front, twin cannons on top, chunky stylised proportions" works; "a cool tank" does not.
- The paint step gets its own words (texture prompt, at most 800 characters): materials, wear and colours — "scratched olive paint, rubber tracks, black tinted glass, brass bolts".

5. CHOOSING THE KIND OF MODEL (say which you chose and why, in plain words)
- For games and editing (the default): Meshy 7.1 shape, remeshed to a quad-dominant mesh of about 30,000 faces, painted by Meshy 7 with PBR maps (colour, metal, roughness, normal) at 2K.
- Low-poly / mobile / lots of props: a Smart Topology model (Meshy T2.5) at the face count asked for (100–30,000; 5,000 is a good mobile prop), painted by Meshy N1 (clean stylised colour, few seams; no PBR, no text prompt). Smart Topology is triangles only.
- Highly detailed / close-up / hero: Meshy 7.1 with no remesh (every bit of detail), 4K paint. Heavy: not for games without a remesh.
- 3D printing: full detail, no remesh; a closed (watertight) mesh matters more than colour; Meshy has a print-repair step.
- Rough guide for games: a mobile character about 5,000 triangles, a PC character about 20,000, a prop 1,000–10,000; remesh anything over 50,000 meant for a game.
- Meshy's models (2026-11-24): shape — meshy-7.1 (newest, most faithful), meshy-6 (clean hard surfaces), meshy-6-lite (cheap drafts, remeshed by default), meshy-t2.5 and meshy-t2 (Smart Topology, low-poly, separate parts with T2); paint — meshy-7 (PBR, up to 8K), meshy-n1 (stylised, base colour). meshy-7 as a SHAPE model stops working on 31 December 2026; "lowpoly" and meshy-t1 are retired. Name models exactly; never rely on "latest".
- Costs (Meshy credits): a Meshy 7.1 or 6 shape 20, a 6 Lite or Smart Topology shape 5, paint 10 (15 at 8K), remesh free. A model takes one to four minutes; Meshy can be slower when busy.

6. AFTER IT IS MADE: CHECK BEFORE YOU CALL IT DONE
- It has paint: the file holds a texture (BeeZilla checks this and paints a bare model again, once).
- It looks like the picture from every side: compare Meshy's four views (front, right, back, left) with the picture; say plainly what differs ("the back was invented", "the cannons came out thinner").
- Its size suits its use: the face count against the budget above.
- Say what you made, what it was made from, its face count and maps, and the one thing most worth fixing. Never say a model is finished, attached or saved before it is.

7. CHANGING ONE PART WITHOUT WRECKING THE REST
- Never regenerate or retexture the whole model to fix one detail: everything else changes too.
- Colour, material, see-through (a windshield), decals, wear on one area: a texture edit limited to that area. On BeeZilla, paint the area on the model with a colour brush (red for one change, blue for another) and write what each colour should become; only the painted area of the texture is changed, everything else stays exactly as it was.
- The shape of one part (add a handle, remove a gun, change a wing): a geometry edit of that part only — Meshy's Edit in its own website (selected part, one sentence; works on untextured Meshy 6 and 7.1 models) or Blender. Not available through Meshy's API: say so instead of pretending.
- Glass that should be see-through needs a material with transparency in the file (glTF alphaMode BLEND, or the transmission extension), not only a darker colour.
- Separate parts: Smart Topology T2 keeps parts apart; Meshy's Auto Split cuts a finished model into parts (keep_texture keeps the paint).
- Order: shape changes first, then paint, then split, rig and animate.

8. PROBLEMS AND FIXES
- Unrelated object → the picture was not used: make it from the picture itself.
- Generic look → keep the picture's look (no enhancement); words: name the style.
- No paint → run the paint step (refine) or repaint (Retexture with the same picture, keeping the UVs).
- Blurry or stretched paint, seams → poor UVs: unwrap again (Meshy UV Unwrap), then repaint; or paint at 4K.
- Baked shadows in the colour → Meshy 7 paint removes them; on Meshy 6 turn on remove lighting.
- Triangle soup, tiny faces → remesh: quad, 10,000–30,000 faces; Smart Topology for low-poly.
- Faces pointing the wrong way, holes → in Blender: Merge by Distance, Recalculate Normals Outside, fill holes; for printing, Meshy's print repair.
- Thin parts missing (antennas, rotor blades, gun barrels) → a bigger, sharper picture where they are clearly visible, or a view where they stand out; or add them in Blender.
- Invented back → give a back view (Multi-Image to 3D).
- Too heavy for a game or the web → remesh lower; for the web, compress the .glb (gltf-transform / meshoptimizer) — never Draco before sending it back to Meshy.
- Meshy refused: 402 = no credits left on BeeZilla's Meshy account; 403 = its content check refused the picture or words; 429 = too busy, try again shortly; 400 = an option that does not fit (say which).

9. GETTING IT INTO OTHER TOOLS
- The .glb holds the mesh and its textures in one file: Blender (File → Import → glTF), Unity (a glTF importer such as glTFast), Unreal (glTF importer), Godot, three.js and websites take it directly. Windows opens it in 3D Viewer.
- Check the scale (Meshy can size a model to its real height and put its origin at the bottom) and that the model faces forward.
- Rigging and animation: Meshy rigs humanoid characters (an A-pose or T-pose helps; up to about 300,000 triangles).

10. BEING HONEST
- Say what was made from what. Say what you could not do. Never invent a parameter, a feature or a price: Meshy's docs (docs.meshy.ai, its llms-full.txt) are the source of truth.
- Keep the work inside the budget they gave; a remesh is free, a new shape or paint costs credits.

Sources: docs.meshy.ai (image-to-3d, multi-image-to-3d, text-to-3d, models, remesh, retexture, deprecations, pricing, rate-limits, errors, webapp guides: texture-edit, meshy-edit, ai-texturing, remesh, auto-split); meshy.ai developer blog "remesh vs smart topology for a game character"; meshy.ai topics "remove photo background for 3D"; help.meshy.ai (better image-to-3D results, copyright checklist); github.com/meshy-dev/meshy-mcp-server and meshy-3d-agent; Blender manual (retopology, normals); three-mesh-bvh; gltf-transform.`;

// Words that make a turn about 3D even without asking for a new model.
const ABOUT_3D = /\b(?:3d|three[\s-]?d|glb|gltf|fbx|obj file|stl file|usdz|mesh(?:es)?|meshy|meshzilla|polygons?|poly ?count|face count|topology|retopo(?:logy)?|remesh(?:ing)?|uv (?:unwrap|map|layout)|pbr|normal map|rig(?:ging|ged)?|blender|unreal engine|godot|low[\s-]?poly)\b/i;

/** Does this turn need Meshzilla's skill? */
export function needsModel3dSkill(input: { message: string; wants3d: boolean; history?: Array<{ role: string; content: string }>; pointedKind?: string | null; expert?: string | null }): boolean {
  if (input.wants3d) return true;
  if (input.expert === "model3d") return true;
  if (input.pointedKind === "3D model") return true;
  const fromExpert = (s: string) => /came from the (?:model3d|3D Models) experts? page/i.test(s);
  if (fromExpert(input.message) || (input.history ?? []).some((h) => typeof h.content === "string" && fromExpert(h.content))) return true;
  return ABOUT_3D.test(String(input.message || ""));
}

/** The block for a turn's instructions (empty when the turn is not about 3D). */
export function model3dSkillBlock(on: boolean): string {
  return on ? "\n\n" + MODEL3D_SKILL : "";
}
