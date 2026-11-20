/**
 * The one board (2026-11-18): search words for saved work, the person's own AI key,
 * and recipes made from a whiteboard selection.
 *
 *   - Every saved file gets at least 45 search words ("if I search house, it should
 *     bring up the picture of a house I asked"), from the model, or from the request's
 *     own words when no model answers.
 *   - Search finds a file by those words, best match first.
 *   - A personal key is sealed at rest, never shown back, and routes only that turn's
 *     completions to the person's own provider — never a private-network address.
 *   - A recipe keeps the selected cards and lines, and turns back into instructions
 *     in the order the lines run.
 *
 * Hermetic: an in-memory PGlite and a local HTTP stand-in for providers.
 *   npx tsx scripts/test-one-board.ts
 */
import { PGlite } from "@electric-sql/pglite";
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

let pass = 0;
let fail = 0;
const ok = async (name: string, fn: () => Promise<void> | void) => {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name} — ${(e as Error).message}`); }
};
const truthy = (v: unknown, msg = "expected truthy") => { if (!v) throw new Error(msg); };
const eq = (a: unknown, b: unknown, msg = "") => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};

// ── A stand-in provider: records the key and model each call carried ────────
type Seen = { auth: string; model: string; body: string };
const seen: Seen[] = [];
let tagReplies: string[][] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed: { model?: string; messages?: Array<{ content?: string }> } = {};
    try { parsed = JSON.parse(body || "{}"); } catch { /* not JSON */ }
    seen.push({ auth: String(req.headers.authorization || ""), model: String(parsed.model || ""), body });
    const system = String(parsed.messages?.[0]?.content || "");
    let content = "plain answer";
    if (/You write search tags/.test(system)) {
      const tags = tagReplies.shift() ?? [];
      content = JSON.stringify({ description: "A small house with a red roof.", tags });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: parsed.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }));
  });
});

(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}/v1`;
  // The deployment's own provider is the stand-in too, on a different key.
  process.env.BZ_CHAT_BASE_URL = base;
  process.env.BZ_CHAT_KEY = "deployment-key";
  process.env.BZ_CHAT_MODEL = "deployment-model";

  const tags = await import("../src/lib/buzzy/tags");
  const llm = await import("../src/lib/buzzy/llm");
  const keys = await import("../src/lib/buzzy/userKeys");
  const recipes = await import("../src/lib/buzzy/boardRecipes");

  const db = new PGlite();
  for (const f of ["0048_buzzy_assets.sql", "0052_buzzy_project_deliverables.sql", "0060_buzzy_one_board.sql"]) {
    await db.exec(readFileSync(join(process.cwd(), "migrations", f), "utf8"));
  }
  // The tagged-template + .query() surface src/lib/db.ts gives the app.
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = "";
    strings.forEach((s, i) => { text += s + (i < values.length ? "$" + (i + 1) : ""); });
    return db.query(text, values).then((r) => r.rows);
  }) as unknown as import("../src/lib/db").Sql;
  (sql as unknown as { query: unknown }).query = (text: string, params?: unknown[]) => db.query(text, params ?? []).then((r) => r.rows);

  console.log("\nThe one board — search words, own key, board recipes\n");

  // ── Search words ──────────────────────────────────────────────────────
  await ok("the word fallback gives a one-subject picture at least 45 tags", () => {
    const r = tags.wordTags({ prompt: "a picture of my house", filename: "IMG_0042.png", contentType: "image/png" });
    truthy(r.tags.length >= tags.MIN_TAGS, `only ${r.tags.length} tags`);
    for (const t of ["house", "houses", "house picture", "picture"]) truthy(r.tags.includes(t), `missing "${t}"`);
    eq(r.source, "words");
  });
  await ok("the word fallback gives music and 3D at least 45 tags too", () => {
    truthy(tags.wordTags({ prompt: "a lullaby", filename: "music-1.mp3", contentType: "audio/mpeg" }).tags.length >= 45, "music");
    truthy(tags.wordTags({ prompt: "a chair", filename: "model-ab.glb", contentType: "model/gltf-binary" }).tags.length >= 45, "3d");
  });
  await ok("tags are lower case, short and free of hashtags", () => {
    eq(tags.cleanTag("#Red Roof"), "red roof");
    eq(tags.cleanTag("one two three four"), null);
    eq(tags.cleanTag("<script>"), null);
    eq(tags.cleanTag(""), null);
  });
  await ok("the kind of a file comes from its type or name", () => {
    eq(tags.kindFor("a.png", ""), "picture");
    eq(tags.kindFor("x", "audio/mpeg"), "music");
    eq(tags.kindFor("m.glb", ""), "3d");
    eq(tags.kindFor("v.mp4", ""), "video");
    eq(tags.kindFor("notes.docx", ""), "document");
  });
  await ok("the model's tags are used, and asked for again when too few", async () => {
    const few = ["house", "home", "roof", "door", "garden", "cottage", "building", "residence", "window", "chimney"];
    const more = Array.from({ length: 40 }, (_, i) => "extra tag " + String.fromCharCode(97 + (i % 26)) + (i >= 26 ? "x" : ""));
    tagReplies = [few, more];
    const before = seen.length;
    const r = await tags.tagsFor({ prompt: "a picture of a house", filename: "art-1.png", contentType: "image/png" });
    eq(r.source, "model");
    eq(seen.length - before, 2, "calls");
    truthy(r.tags.length >= tags.MIN_TAGS, `only ${r.tags.length}`);
    truthy(r.tags.includes("cottage"), "kept the model's words");
  });
  await ok("an unreachable model falls back to the words, still 45+", async () => {
    const r = await llm.withLlmOverride({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "x" }, () =>
      tags.tagsFor({ prompt: "a picture of a house", filename: "art-2.png", contentType: "image/png" }));
    eq(r.source, "words");
    truthy(r.tags.length >= 45, `only ${r.tags.length}`);
  });

  // Two files: the house picture (named like a machine would name it) and a song.
  const house = (await db.query<{ id: number }>(
    "INSERT INTO buzzy_assets (user_id, sha256, filename, rel_path, content_type, bytes, body) VALUES ($1,$2,$3,$3,$4,1,$5) RETURNING id",
    ["u1", "h".repeat(64), "art-2026-11-07-06-20-01.png", "image/png", Buffer.from([1])])).rows[0]!.id;
  const song = (await db.query<{ id: number }>(
    "INSERT INTO buzzy_assets (user_id, sha256, filename, rel_path, content_type, bytes, body) VALUES ($1,$2,$3,$3,$4,1,$5) RETURNING id",
    ["u1", "s".repeat(64), "music-2026-11-07.mp3", "audio/mpeg", Buffer.from([2])])).rows[0]!.id;
  const other = (await db.query<{ id: number }>(
    "INSERT INTO buzzy_assets (user_id, sha256, filename, rel_path, content_type, bytes, body) VALUES ($1,$2,$3,$3,$4,1,$5) RETURNING id",
    ["u2", "o".repeat(64), "house.png", "image/png", Buffer.from([3])])).rows[0]!.id;
  await tags.saveTags(sql, "u1", house, tags.wordTags({ prompt: "a cosy cottage house with a red roof", filename: "art.png", contentType: "image/png" }));
  await tags.saveTags(sql, "u1", song, tags.wordTags({ prompt: "a gentle piano lullaby", filename: "music.mp3", contentType: "audio/mpeg" }));
  await tags.saveTags(sql, "u2", other, tags.wordTags({ prompt: "a house", filename: "house.png", contentType: "image/png" }));

  await ok("searching 'house' finds the house picture by its words, not its file name", async () => {
    const hits = await tags.searchTagged(sql, "u1", "house");
    eq(hits.map((h) => h.id), [house]);
    eq(hits[0]!.kind, "picture");
    truthy(hits[0]!.tagCount >= 45, "tag count travels with the hit");
  });
  await ok("other words for it work too: cottage, red roof, houses", async () => {
    for (const q of ["cottage", "red roof", "houses"]) eq((await tags.searchTagged(sql, "u1", q)).map((h) => h.id), [house], q);
  });
  await ok("music is found as music", async () => {
    const hits = await tags.searchTagged(sql, "u1", "lullaby");
    eq(hits.map((h) => h.id), [song]);
    eq(hits[0]!.kind, "music");
    truthy((await tags.searchTagged(sql, "u1", "song")).some((h) => h.id === song), "'song' finds the track");
  });
  await ok("someone else's files never show up", async () => {
    truthy(!(await tags.searchTagged(sql, "u1", "house")).some((h) => h.id === other), "u2's house leaked");
  });
  await ok("a search with nothing behind it finds nothing", async () => {
    eq((await tags.searchTagged(sql, "u1", "spaceship")).length, 0);
  });
  await ok("the same file saved again keeps its first words and gains the new ones", async () => {
    await tags.saveTags(sql, "u1", house, { description: "A barn.", tags: ["barn", "farm"], source: "words" });
    const t = await tags.tagsOf(sql, "u1", house);
    truthy(t && t.tags.includes("cottage") && t.tags.includes("barn"), "merged");
    eq((await tags.searchTagged(sql, "u1", "house")).map((h) => h.id), [house], "house still finds it");
  });
  await ok("the file the person asked for ranks first", async () => {
    await tags.saveTags(sql, "u1", song, { description: "A lullaby with a house beat.", tags: ["house beat", "lullaby"], source: "model" });
    const hits = await tags.searchTagged(sql, "u1", "house");
    eq(hits[0]!.id, house, "exact tag beats a partial one");
  });

  // ── A song right after a picture is a song ─────────────────────────────
  await ok("a song asked for after a picture is not another picture", async () => {
    const intent = await import("../src/lib/buzzy/intent");
    const history = [{ role: "user", content: "draw me a picture of a house" }, { role: "assistant", content: "Here is the picture." }];
    eq(intent.isImageRequest("make me a short happy song", { history }), false, "song");
    eq(intent.isImageRequest("make a 3D model of a chair", { history }), false, "3d");
    eq(intent.isImageRequest("now one with a red barn in the snow", { history }), true, "a picture follow-up still works");
    eq(intent.isImageRequest("make a song with a cover picture", { history }), true, "naming a picture still works");
  });

  // ── Own AI key ────────────────────────────────────────────────────────
  await ok("a key is sealed and opens again; a tampered one does not", () => {
    const sealed = keys.sealSecret("sk-live-abcdef1234");
    truthy(!sealed.includes("abcdef"), "plain text in the seal");
    eq(keys.openSecret(sealed), "sk-live-abcdef1234");
    const parts = sealed.split(".");
    parts[3] = parts[3]!.slice(0, -2) + (parts[3]!.endsWith("A") ? "B" : "A");
    eq(keys.openSecret(parts.join(".")), null);
  });
  await ok("only public https addresses are accepted on the cloud", () => {
    delete process.env.BZ_ALLOW_LOCAL_AI_KEY_URL;
    // A cloud deployment: its own model is not on this machine. (A local runtime,
    // whose BZ_CHAT_BASE_URL is localhost, may use local addresses — tested below.)
    const own = process.env.BZ_CHAT_BASE_URL;
    process.env.BZ_CHAT_BASE_URL = "https://inference.example.com/v1";
    try { cloudChecks(); } finally { process.env.BZ_CHAT_BASE_URL = own; }
  });
  function cloudChecks() {
    truthy(keys.cleanBaseUrl("https://openrouter.ai/api/v1"), "public https");
    for (const bad of ["http://openrouter.ai/api/v1", "http://127.0.0.1:8080/v1", "https://10.0.0.5/v1", "https://192.168.1.4/v1",
      "https://169.254.169.254/latest", "https://localhost/v1", "https://box.internal/v1", "https://[::1]/v1", "https://u:p@x.com/v1", "ftp://x.com"]) {
      eq(keys.cleanBaseUrl(bad), null, bad);
    }
  }
  await ok("private addresses are recognised", () => {
    for (const h of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.0.10", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "localhost", "db.internal"]) {
      truthy(keys.isPrivateHost(h), h);
    }
    for (const h of ["8.8.8.8", "openrouter.ai", "2606:4700::1111"]) truthy(!keys.isPrivateHost(h), h);
  });
  await ok("a local runtime may use this machine's address", () => {
    process.env.BZ_ALLOW_LOCAL_AI_KEY_URL = "1";
    truthy(keys.cleanBaseUrl(base), "local allowed");
  });
  await ok("saving shows back only the last four characters", async () => {
    const r = await keys.saveKey(sql, "u1", { provider: "custom", baseUrl: base, apiKey: "sk-own-key-9876", model: "their-model" });
    truthy(r.ok, "saved");
    const s = await keys.keySummary(sql, "u1");
    eq(s.hint, "9876");
    eq(s.model, "their-model");
    truthy(!JSON.stringify(s).includes("sk-own"), "the key leaked into the summary");
    const raw = await db.query<{ key_sealed: string }>("SELECT key_sealed FROM buzzy_user_ai_keys WHERE user_id = 'u1'");
    truthy(!raw.rows[0]!.key_sealed.includes("sk-own"), "stored in clear text");
  });
  await ok("bad keys and model names are refused with a plain reason", async () => {
    const short = await keys.saveKey(sql, "u3", { provider: "openrouter", apiKey: "abc" });
    truthy(!short.ok && short.code === "bad_key", "short key");
    const spaced = await keys.saveKey(sql, "u3", { provider: "openrouter", apiKey: "sk-has a space-123" });
    truthy(!spaced.ok && spaced.code === "bad_key", "spaced key");
    const model = await keys.saveKey(sql, "u3", { provider: "openrouter", apiKey: "sk-fine-12345678", model: "<bad>" });
    truthy(!model.ok && model.code === "bad_model", "bad model");
  });
  await ok("a turn on the person's key goes to their provider with their key and model", async () => {
    const o = await keys.overrideFor(sql, "u1");
    truthy(o, "override");
    const before = seen.length;
    await llm.withLlmOverride(o, () => llm.chatCompletion([{ role: "user", content: "hi" }], { model: "catalog-model" }));
    const call = seen[before]!;
    eq(call.auth, "Bearer sk-own-key-9876");
    eq(call.model, "their-model");
  });
  await ok("outside it, the deployment's key and model are used", async () => {
    const before = seen.length;
    await llm.chatCompletion([{ role: "user", content: "hi" }]);
    eq(seen[before]!.auth, "Bearer deployment-key");
    eq(seen[before]!.model, "deployment-model");
  });
  await ok("two people's turns at once never borrow each other's key", async () => {
    const before = seen.length;
    await Promise.all([
      llm.withLlmOverride({ baseUrl: base, apiKey: "key-A", model: "mA" }, async () => {
        await new Promise((r) => setTimeout(r, 15));
        await llm.chatCompletion([{ role: "user", content: "a" }]);
      }),
      llm.withLlmOverride({ baseUrl: base, apiKey: "key-B", model: "mB" }, () => llm.chatCompletion([{ role: "user", content: "b" }])),
    ]);
    const calls = seen.slice(before);
    truthy(calls.some((c) => c.auth === "Bearer key-A" && c.model === "mA"), "A");
    truthy(calls.some((c) => c.auth === "Bearer key-B" && c.model === "mB"), "B");
    truthy(!calls.some((c) => (c.auth === "Bearer key-A" && c.model === "mB") || (c.auth === "Bearer key-B" && c.model === "mA")), "mixed");
  });
  await ok("removing the key returns the person to the deployment's AI", async () => {
    await keys.deleteKey(sql, "u1");
    eq(await keys.overrideFor(sql, "u1"), null);
    eq((await keys.keySummary(sql, "u1")).saved, false);
  });

  // ── Board recipes ─────────────────────────────────────────────────────
  const graph = {
    nodes: [
      { id: "out", kind: "output", title: "Poster", body: "A4, bold", x: 800, y: 0 },
      { id: "s2", kind: "skill", title: "Draw it", body: "Make the picture", x: 500, y: 0 },
      { id: "a", kind: "agent", title: "agent.md", body: "Be brief.", x: 0, y: 0 },
      { id: "s1", kind: "skill", title: "Research", body: "Look up the venue", x: 250, y: 0 },
    ],
    links: [{ from: "a", to: "s1" }, { from: "s1", to: "s2" }, { from: "s2", to: "out" }, { from: "a", to: "ghost" }],
  };
  await ok("a selection becomes a recipe; lines to cards outside it are dropped", () => {
    const r = recipes.cleanGraph(graph);
    truthy(r.ok, "clean");
    if (r.ok) eq(r.graph.links.length, 3);
  });
  await ok("nothing selected, or too much, is refused", () => {
    truthy(!recipes.cleanGraph({ nodes: [] }).ok, "empty");
    truthy(!recipes.cleanGraph({ nodes: Array.from({ length: 41 }, (_, i) => ({ id: "n" + i, kind: "note", title: "x", body: "", x: 0, y: 0 })) }).ok, "too many");
  });
  await ok("the recipe reads in the order its lines run", () => {
    const r = recipes.cleanGraph(graph);
    if (!r.ok) throw new Error("clean");
    const text = recipes.recipeInstructions("Gig poster", r.graph);
    const iAgent = text.indexOf("agent.md"), i1 = text.indexOf("Step 1 — Research"), i2 = text.indexOf("Step 2 — Draw it"), iOut = text.indexOf("End result — Poster");
    truthy(iAgent >= 0 && i1 > iAgent && i2 > i1 && iOut > i2, text);
  });
  await ok("recipes are saved per person, listed, and deleted only by their owner", async () => {
    const saved = await recipes.saveBoardRecipe(sql, "u1", { name: "Gig poster", graph });
    truthy(saved.ok, "saved");
    if (!saved.ok) return;
    eq((await recipes.listBoardRecipes(sql, "u1")).map((r) => r.name), ["Gig poster"]);
    eq((await recipes.listBoardRecipes(sql, "u2")).length, 0, "u2 sees none");
    eq(await recipes.deleteBoardRecipe(sql, "u2", saved.recipe.id), false, "u2 cannot delete");
    eq(await recipes.deleteBoardRecipe(sql, "u1", saved.recipe.id), true);
  });

  // ── Closing the account ───────────────────────────────────────────────
  await ok("closing an account removes its own key, recipes and search words, and no one else's", async () => {
    const { DELETION_STATEMENTS } = await import("../src/lib/buzzy/portability");
    const tables = ["buzzy_user_ai_keys", "buzzy_board_recipes", "buzzy_asset_tags"];
    for (const who of ["u8", "u9"]) {
      truthy((await keys.saveKey(sql, who, { provider: "custom", baseUrl: base, apiKey: "sk-close-key-4321" })).ok, `${who} key`);
      truthy((await recipes.saveBoardRecipe(sql, who, { name: "Gig poster", graph })).ok, `${who} recipe`);
      const id = (await db.query<{ id: number }>(
        "INSERT INTO buzzy_assets (user_id, sha256, filename, rel_path, content_type, bytes, body) VALUES ($1,$2,$3,$3,$4,1,$5) RETURNING id",
        [who, (who === "u8" ? "8" : "9").repeat(64), "art.png", "image/png", Buffer.from([8])])).rows[0]!.id;
      await tags.saveTags(sql, who, id, tags.wordTags({ prompt: "a house", filename: "art.png", contentType: "image/png" }));
    }
    for (const t of tables) {
      truthy(DELETION_STATEMENTS[t], `${t} is not removed with the account`);
      await sql.query(DELETION_STATEMENTS[t]!, ["u9"]);
      const count = async (who: string) =>
        (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE user_id = $1`, [who])).rows[0]!.n;
      eq(await count("u9"), 0, `${t} left behind:`);
      eq(await count("u8"), 1, `${t} someone else's rows:`);
    }
  });

  server.close();
  await db.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
