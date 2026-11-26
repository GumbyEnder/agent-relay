/**
 * The Zilla agents (2026-11-21): dedicated helpers in the left sidebar, each with a name,
 * a size, a colour and a job.
 *
 *   - The roster: twelve colours, four creatures, and a picture file for every pair
 *     (public/buzzy/zillas); what + adds next, in order, never the plain bee.
 *   - A person starts with one greyed-out bunny, made once: not twice when two first
 *     visits race, and never again after it is deleted.
 *   - Everything a person can set is checked; refusals say what to do instead.
 *   - What the person says becomes a short job ("to-do list") and an emoji for it, with
 *     the owner's own sentences as the examples; an empty answer asks again.
 *   - Telling an agent its job keeps the whole exchange in the conversation, from the
 *     agent's first question, and tags the conversation as the agent's.
 *   - A conversation decides who answers: the agent's name and job go into the prompt,
 *     BeeZilla's own turns list the agents that have a job, and a person with no agents
 *     gets the prompt exactly as before (checked through the real chat loop against a
 *     stand-in model).
 *   - Everything is the person's own: another account's agent is answered like one that
 *     does not exist, and closing an account removes the agents and the starter marker.
 *   - The same through the real /api/buzzy handler, signed in with real sessions (magic
 *     link, in-process): list, add, change, tell it its job, start a conversation with it,
 *     talk in it (the stand-in model is sent the agent's job), reopen it from History; a
 *     signed-out caller, another account, an oversized body and bad JSON are refused.
 *
 * Hermetic: every migration on an in-memory PGlite and a local stand-in for the model.
 *   npx tsx scripts/test-agents.ts          (AGENTS_SHOW=1 also prints a real list answer)
 */
import http from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { H3 } from "h3";
import * as ag from "../src/lib/buzzy/agents";
import { deleteAccountData, DELETION_STATEMENTS } from "../src/lib/buzzy/portability";

// This test must never reach a real database: the in-memory one is what getSql() gives
// when no DATABASE_URL is set, and that is checked before anything else loads.
delete process.env.DATABASE_URL;

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

// ── A stand-in model: records every system prompt it was sent ───────────────
const prompts: string[] = [];
const model = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed: { model?: string; messages?: Array<{ role?: string; content?: string }> } = {};
    try { parsed = JSON.parse(body || "{}"); } catch { /* not JSON */ }
    const system = (parsed.messages || []).filter((m) => m.role === "system").map((m) => String(m.content || "")).join("\n");
    if (system) prompts.push(system);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      model: parsed.model || "stand-in",
      choices: [{ index: 0, message: { role: "assistant", content: "Happy to help with that." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  });
});

(async () => {
  await new Promise<void>((r) => model.listen(0, "127.0.0.1", () => r()));
  process.env.BZ_CHAT_BASE_URL = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
  process.env.BZ_CHAT_KEY = "stand-in-key";
  process.env.BZ_CHAT_MODEL = "stand-in-model";

  const { getSql } = await import("../src/lib/db");
  const sql = await getSql();
  const server = await import("../src/lib/buzzy/server");
  const route = (user: string, method: string, rest: string, body?: unknown) => ag.agentsRoute(sql, user, method, rest, body);
  const count = async (table: string, user: string) =>
    Number(((await sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [user]))[0] as { n: number }).n);
  const session = async (id: string, user: string, agentId: string | null = null) => {
    await sql.query("INSERT INTO buzzy_sessions (id, user_id, agent_id) VALUES ($1, $2, $3)", [id, user, agentId]);
  };

  console.log("\nThe roster\n");

  await ok("twelve named colours, each a #RRGGBB, and four creatures", () => {
    eq(ag.COLORS.map((c) => c.name), ["red", "orange", "yellow", "lime", "green", "teal", "sky", "blue", "indigo", "purple", "magenta", "pink"]);
    for (const c of ag.COLORS) truthy(/^#[0-9A-F]{6}$/.test(c.hex), `${c.name} ${c.hex}`);
    eq(ag.CREATURES.map((c) => c.id), ["bee", "bunny", "bull", "frog"]);
    eq(ag.creatureOf("bunny")?.color, "#F08CA0", "the bunny is pink, as the owner said");
    eq(ag.colorOf("red")?.hex, "#E44449", "hsl(358, 75%, 58%)");
    eq(ag.colorOf("sky")?.hex, ag.COLORS[6]!.hex);
  });
  await ok("every creature, in its own art and in every colour, has a picture file", () => {
    eq(ag.agentImage("bunny", ""), "/buzzy/zillas/bunny.webp");
    eq(ag.agentImage("frog", "blue"), "/buzzy/zillas/frog-blue.webp");
    const dir = join(process.cwd(), "public", "buzzy", "zillas");
    let n = 0;
    for (const c of ag.CREATURES) {
      for (const look of ["", ...ag.COLORS.map((k) => k.name)]) {
        truthy(existsSync(join(dir, ag.agentImage(c.id, look).split("/").pop()!)), `${c.id} ${look || "(own art)"} has no picture`);
        n++;
      }
    }
    eq(n, 52);
  });
  await ok("BeeZilla herself is fixed: large, ready, the bee's own art", () => {
    eq([ag.BZILLA.id, ag.BZILLA.name, ag.BZILLA.size, ag.BZILLA.ready, ag.BZILLA.image], ["bzilla", "BeeZilla", "l", true, "/buzzy/zillas/bee.webp"]);
  });
  await ok("what + adds: bunny, bull, frog in their own art, then one colour at a time; never the plain bee", () => {
    const have: Array<{ creature: string; look: string; name: string }> = [];
    const names: string[] = [];
    for (let i = 0; i < 51; i++) {
      const d = ag.nextDefault(have);
      truthy(!(d.creature === "bee" && d.look === ""), "the plain bee was offered");
      have.push({ creature: d.creature, look: d.look, name: d.name });
      names.push(d.name);
    }
    eq(names.slice(0, 10), ["Bunnyzilla", "Bullzilla", "Frogzilla", "Red Beezilla", "Red Bunnyzilla", "Red Bullzilla", "Red Frogzilla", "Orange Beezilla", "Orange Bunnyzilla", "Orange Bullzilla"]);
    eq(new Set(names.map((n) => n.toLowerCase())).size, 51, "names are all different");
    eq(have.at(-1), { creature: "frog", look: "pink", name: "Pink Frogzilla" });
    const again = ag.nextDefault(have);
    eq([again.creature, again.look, again.name], ["bunny", "", "Bunnyzilla 2"], "after all fifty-one it goes round, numbered");
    eq(ag.nextDefault(have.slice(0, 1)).name, "Bullzilla", "with only the bunny it adds the bull");
    const blue = ag.nextDefault([{ creature: "bunny", look: "", name: "x" }, { creature: "bull", look: "", name: "x" }, { creature: "frog", look: "", name: "x" }, { creature: "bee", look: "red", name: "x" }, { creature: "bunny", look: "red", name: "x" }, { creature: "bull", look: "red", name: "x" }, { creature: "frog", look: "red", name: "x" }]);
    eq([blue.name, blue.color, blue.image], ["Orange Beezilla", ag.colorOf("orange")!.hex, "/buzzy/zillas/bee-orange.webp"]);
  });

  console.log("\nChecking what a person sets\n");

  await ok("each field is checked, and a refusal says what to do", () => {
    const bad = (raw: Record<string, unknown>) => { const r = ag.checkFields(raw); if (r.ok) throw new Error(`accepted ${JSON.stringify(raw)}`); return r; };
    eq(bad({ creature: "dragon" }).code, "bad_creature");
    eq(bad({ look: "chartreuse" }).code, "bad_look");
    eq(bad({ look: 5 }).code, "bad_look");
    eq(bad({ name: "" }).code, "bad_name");
    eq(bad({ name: "<>" }).code, "bad_name", "nothing is left of it");
    eq(bad({ color: "pink" }).code, "bad_color");
    eq(bad({ color: "#12345" }).code, "bad_color");
    eq(bad({ size: "xl" }).code, "bad_size");
    eq(bad({ face: "ab" }).code, "bad_face");
    eq(bad({ face: "✅✅" }).code, "bad_face", "two emoji are not a face");
    eq(bad({ face: "7" }).code, "bad_face", "a digit is not an emoji");
    for (const r of [bad({ creature: "x" }), bad({ color: "x" }), bad({ size: "x" })]) {
      truthy(/[a-z]/.test(r.error) && r.status === 400, r.error);
    }
    const good = ag.checkFields({ creature: "frog", look: "", name: "  Fin   the   Frog ", color: "#8cb83a", size: "l", role: "  to-do   list ", instructions: "a\nb", face: "✅" });
    truthy(good.ok, "valid fields");
    if (good.ok) eq(good.fields, { creature: "frog", look: "", name: "Fin the Frog", color: "#8CB83A", size: "l", role: "to-do list", instructions: "a b", face: "✅" });
  });
  await ok("a face is exactly one emoji: flags, keycaps, skin tones and the ones in the job table all pass", () => {
    for (const e of ["✅", "🗓️", "🇺🇸", "👍🏽", "1️⃣", "👨‍👩‍👧", "🏋️", "☂️", "⛅"]) truthy(ag.isSingleEmoji(e), `${e} should be one emoji`);
    for (const e of ["", "a", "ab", "✅✅", "1", "hello 🙂", "🙂 "]) truthy(!ag.isSingleEmoji(e), `${JSON.stringify(e)} should not be`);
    for (const e of ag.FACE_EMOJIS) truthy(ag.isSingleEmoji(e), `${e} from the table is not accepted as a face`);
    eq(ag.checkFields({ face: null }).ok, true, "no face is allowed");
  });
  await ok("names lose control characters and angle brackets, and are cut by whole characters at 40", () => {
    const r = ag.checkFields({ name: "Bun\u0000ny\u0007 <b>zilla</b>\n" });
    truthy(r.ok);
    // eslint-disable-next-line no-control-regex -- deliberate: looks for control bytes that should be gone
    const CONTROLS_OR_ANGLES = /[<>\u0000-\u001f]/;
    if (r.ok) { truthy(!CONTROLS_OR_ANGLES.test(r.fields.name!), r.fields.name); eq(r.fields.name, "Bunny bzilla/b"); }
    const long = ag.checkFields({ name: "🐰".repeat(60) });
    truthy(long.ok);
    if (long.ok) eq(Array.from(long.fields.name!).length, 40, "forty characters, no emoji cut in half");
    const half = ag.checkFields({ name: "a".repeat(39) + "🐰🐰" });
    if (half.ok) truthy(!/[\uD800-\uDBFF]$/.test(half.fields.name!), "no lone half of an emoji at the end");
    const role = ag.checkFields({ role: "x".repeat(200), instructions: "y".repeat(2000) });
    if (role.ok) eq([role.fields.role!.length, role.fields.instructions!.length], [ag.ROLE_MAX, ag.INSTRUCTIONS_MAX]);
  });

  console.log("\nThe job, and its face, from the person's own words\n");

  await ok("the owner's sentences become short jobs", () => {
    const cases: Array<[string, string]> = [
      ["You're in charge of my to-do list", "to-do list"],
      ["you are in charge of my to-do list.", "to-do list"],
      ["my job is to help with calendars", "calendars"],
      ["help me with calendars", "calendars"],
      ["Help with calendars", "calendars"],
      ["Take care of my real estate business", "real estate business"],
      ["Planning our trips", "planning our trips"],
      ["calendars", "calendars"],
      ["I want you to help me with my calendars", "calendars"],
      ["Can you please manage my email inbox for me?", "email inbox"],
      ["Hi! You’re in charge of my kids' school calendar.", "kids' school calendar"],
      ["Be my travel planner", "travel planner"],
      ["Your job is to keep track of my bills", "bills"],
      ["run my store", "store"],
      ["CRM follow-ups", "CRM follow-ups"],
      ["Take care of my real estate business. I own three rentals and want rent reminders.", "real estate business"],
      ["  ", ""],
      ["", ""],
      ["please", ""],
      ["Help me with", ""],
      ["ok", ""],
    ];
    for (const [said, want] of cases) eq(ag.roleFromText(said), want, JSON.stringify(said));
    eq(ag.roleFromText(undefined), "");
    eq(ag.roleFromText(42), "");
    const long = ag.roleFromText("handle " + "organising the weekly team rota and all the little things that come up ".repeat(4));
    truthy(long.length <= ag.ROLE_MAX && !/\s$/.test(long), `cut at a word boundary: ${long.length}`);
    truthy(!/[<>]/.test(ag.roleFromText("handle <script>alert(1)</script> things")), "no angle brackets");
  });
  await ok("a face for the job, from a plain table; ✨ when nothing is recognised, nothing when there is no job", () => {
    const cases: Array<[string, string]> = [
      ["to-do list", "✅"], ["calendars", "🗓️"], ["email inbox", "✉️"], ["taxes", "🧾"], ["monthly budget", "💰"],
      ["planning our trips", "✈️"], ["real estate business", "🏠"], ["workouts", "🏋️"], ["recipes", "🍳"], ["homework", "📚"],
      ["grocery shopping list", "🛒"], ["kids' school", "📚"], ["my dog", "🐶"], ["social media posts", "📱"], ["video games", "🎮"],
      ["contracts", "⚖️"], ["house repairs", "🔧"], ["learning Spanish", "🗣️"], ["xyzzy plugh", "✨"], ["", ""],
    ];
    for (const [role, want] of cases) eq(ag.faceForRole(role), want, JSON.stringify(role));
  });

  console.log("\nThe starter agent\n");

  await ok("a new person's first look makes one greyed-out Bunnyzilla, with the question ready", async () => {
    const out = await route("u1", "GET", "");
    eq(out.status, 200);
    const agents = out.body.agents as ag.Agent[];
    eq(agents.length, 1);
    const b = agents[0]!;
    eq([b.name, b.creature, b.look, b.color, b.size, b.role, b.face, b.pos, b.ready], ["Bunnyzilla", "bunny", "", "#F08CA0", "m", "", "", 0, false]);
    eq(b.image, "/buzzy/zillas/bunny.webp");
    truthy(/^What role do you want me to play\?\n\nAgents like me are dedicated helpers\./.test(b.opening), b.opening);
    truthy(/^ag_[a-z0-9]{12}$/.test(b.id), b.id);
    eq(b.lastSessionId, null);
    eq(out.body.bzilla, ag.BZILLA);
    eq((out.body.next as ag.DefaultAgent).name, "Bullzilla", "+ would add the bull next");
    eq((out.body.colors as unknown[]).length, 12);
    eq((out.body.creatures as Array<{ name: string }>).map((c) => c.name), ["Beezilla", "Bunnyzilla", "Bullzilla", "Frogzilla"]);
    if (process.env.AGENTS_SHOW) console.log(JSON.stringify(out.body, null, 2));
  });
  await ok("looking again never makes a second one, even when five first visits race", async () => {
    eq(((await route("u1", "GET", "")).body.agents as unknown[]).length, 1);
    const racers = await Promise.all([1, 2, 3, 4, 5].map(() => route("u2", "GET", "")));
    for (const r of racers) eq(r.status, 200);
    eq(await count("buzzy_agents", "u2"), 1, "one bunny");
    eq(await count("buzzy_agent_seed", "u2"), 1, "one marker");
  });
  await ok("a deleted starter never comes back", async () => {
    const id = ((await route("u3", "GET", "")).body.agents as ag.Agent[])[0]!.id;
    eq((await route("u3", "DELETE", id)).status, 200);
    eq(((await route("u3", "GET", "")).body.agents as unknown[]).length, 0);
    eq(((await route("u3", "GET", "")).body.agents as unknown[]).length, 0, "and still none");
    eq(await count("buzzy_agent_seed", "u3"), 1, "the marker stays");
    eq((await route("u3", "POST", "", {})).status, 201, "but they can add their own");
    eq(((await route("u3", "GET", "")).body.agents as unknown[]).length, 1);
  });

  console.log("\nAdding, changing and removing agents\n");

  await ok("+ adds the next default, at the end, with the default colour and size", async () => {
    const r = await route("u1", "POST", "", {});
    eq(r.status, 201);
    const a = r.body.agent as ag.Agent;
    eq([a.name, a.creature, a.look, a.size, a.color, a.ready, a.pos], ["Bullzilla", "bull", "", "m", "#E07B39", false, 1]);
    const f = (await route("u1", "POST", "", {})).body.agent as ag.Agent;
    eq([f.name, f.pos], ["Frogzilla", 2]);
    const c = (await route("u1", "POST", "", {})).body.agent as ag.Agent;
    eq([c.name, c.look, c.color], ["Red Beezilla", "red", ag.colorOf("red")!.hex]);
    eq(((await route("u1", "GET", "")).body.agents as ag.Agent[]).map((x) => x.name), ["Bunnyzilla", "Bullzilla", "Frogzilla", "Red Beezilla"], "in the order added");
    eq(((await route("u1", "GET", "")).body.next as ag.DefaultAgent).name, "Red Bunnyzilla");
  });
  await ok("a Zilla can be picked: its colour version takes that colour, its name is made different from the ones they have", async () => {
    const r = await route("u1", "POST", "", { creature: "frog", look: "blue", size: "l" });
    const a = r.body.agent as ag.Agent;
    eq([a.name, a.look, a.size, a.color], ["Blue Frogzilla", "blue", "l", ag.colorOf("blue")!.hex]);
    const own = (await route("u1", "POST", "", { creature: "bunny" })).body.agent as ag.Agent;
    eq([own.name, own.look, own.color], ["Bunnyzilla 2", "", "#F08CA0"], "the bunny's own art again, numbered");
    const named = (await route("u1", "POST", "", { creature: "bull", look: "teal", name: "  Rusty  ", color: "#112233" })).body.agent as ag.Agent;
    eq([named.name, named.color], ["Rusty", "#112233"]);
  });
  await ok("the plain bee is BeeZilla's: a bee needs a colour; a bad request creates nothing", async () => {
    const before = await count("buzzy_agents", "u1");
    const r = await route("u1", "POST", "", { creature: "bee" });
    eq([r.status, r.body.code], [400, "bee_reserved"]);
    truthy(/BeeZilla/.test(String(r.body.error)) && /colour/.test(String(r.body.error)), String(r.body.error));
    eq((await route("u1", "POST", "", { creature: "bee", look: "red" })).status, 201, "a red bee is an agent");
    eq((await route("u1", "POST", "", { creature: "dragon" })).status, 400);
    eq((await route("u1", "POST", "", { size: "huge" })).status, 400);
    eq(await count("buzzy_agents", "u1"), before + 1, "only the red bee was made");
  });
  await ok("changing an agent: name, size, colour; a new look takes its colour; a new job takes its face unless they chose one", async () => {
    const [bunny] = (await route("u1", "GET", "")).body.agents as ag.Agent[];
    const id = bunny!.id;
    let r = await route("u1", "PATCH", id, { name: "Hopper", size: "s", color: "#ff00aa" });
    eq(r.status, 200);
    let a = r.body.agent as ag.Agent;
    eq([a.name, a.size, a.color], ["Hopper", "s", "#FF00AA"]);
    r = await route("u1", "PATCH", id, { look: "blue" });
    a = r.body.agent as ag.Agent;
    eq([a.look, a.color, a.image], ["blue", ag.colorOf("blue")!.hex, "/buzzy/zillas/bunny-blue.webp"]);
    r = await route("u1", "PATCH", id, { role: "calendars" });
    a = r.body.agent as ag.Agent;
    eq([a.role, a.face, a.ready, a.opening], ["calendars", "🗓️", true, "Hi, I'm Hopper. I help with calendars. What do you need?"]);
    r = await route("u1", "PATCH", id, { face: "🐝" });
    eq((r.body.agent as ag.Agent).face, "🐝");
    r = await route("u1", "PATCH", id, { role: "to-do list" });
    eq((r.body.agent as ag.Agent).face, "🐝", "a face they chose stays when the job changes");
    r = await route("u1", "PATCH", id, { role: "" });
    a = r.body.agent as ag.Agent;
    eq([a.ready, a.role], [false, ""], "an empty job greys it out again");
    eq((await route("u1", "PATCH", id, {})).body.code, "nothing_to_change");
    eq((await route("u1", "PATCH", id, { size: "q" })).status, 400);
  });
  await ok("removing an agent: once; its conversations stay, as ordinary ones", async () => {
    const made = (await route("u1", "POST", "", { creature: "frog", look: "lime" })).body.agent as ag.Agent;
    await session("sess_gone1", "u1", made.id);
    eq((await route("u1", "DELETE", made.id)).status, 200);
    const again = await route("u1", "DELETE", made.id);
    eq([again.status, again.body.code], [404, "not_found"]);
    const left = await sql.query<{ agent_id: string | null }>("SELECT agent_id FROM buzzy_sessions WHERE id = 'sess_gone1'");
    eq(left[0]!.agent_id, null, "the conversation is BeeZilla's now");
    eq(await ag.agentForSession(sql, "u1", "sess_gone1"), null);
  });
  await ok("a person keeps at most 500 agents; the 501st is refused in plain words, and room comes back with a removal", async () => {
    eq(ag.AGENTS_MAX, 500);
    await route("ucap", "GET", ""); // the starter: 1
    await sql.query(
      `INSERT INTO buzzy_agents (id, user_id, creature, look, name, color, pos)
       SELECT 'ag_' || lpad(g::text, 12, '0'), 'ucap', 'frog', 'red', 'Filler ' || g, '#E44449', g FROM generate_series(1, 499) g`,
    );
    eq(await count("buzzy_agents", "ucap"), 500);
    const r = await route("ucap", "POST", "", {});
    eq([r.status, r.body.code], [409, "too_many"]);
    truthy(/500/.test(String(r.body.error)) && /Remove one/.test(String(r.body.error)), String(r.body.error));
    eq(await count("buzzy_agents", "ucap"), 500, "nothing was added");
    eq((await route("ucap", "DELETE", "ag_000000000007")).status, 200);
    eq((await route("ucap", "POST", "", {})).status, 201, "room again");
    eq(((await route("ucap", "GET", "")).body.agents as unknown[]).length, 500);
  });

  console.log("\nTelling an agent its job\n");

  await ok("\"You're in charge of my to-do list\": the job, the checklist face, and the agent says so in its own voice", async () => {
    const id = ((await route("u4", "GET", "")).body.agents as ag.Agent[])[0]!.id;
    const r = await route("u4", "POST", `${id}/identity`, { text: "You're in charge of my to-do list" });
    eq([r.status, r.body.saved], [200, true]);
    const a = r.body.agent as ag.Agent;
    eq([a.role, a.face, a.ready, a.instructions], ["to-do list", "✅", true, "You're in charge of my to-do list"]);
    eq(r.body.reply, "Got it. From now on I help with to-do list. Tell me what you need.");
    eq(a.opening, "Hi, I'm Bunnyzilla. I help with to-do list. What do you need?");
    const stored = ((await route("u4", "GET", "")).body.agents as ag.Agent[])[0]!;
    eq([stored.role, stored.face, stored.ready], ["to-do list", "✅", true], "kept");
  });
  await ok("no job in the words: the agent asks again and nothing is saved", async () => {
    const id = ((await route("u5", "GET", "")).body.agents as ag.Agent[])[0]!.id;
    for (const text of ["", "   ", "please", "ok", undefined, 7]) {
      const r = await route("u5", "POST", `${id}/identity`, { text });
      eq([r.status, r.body.saved, r.body.agent], [200, false, undefined], JSON.stringify(text));
      truthy(/What would you like me to take care of\?/.test(String(r.body.reply)), String(r.body.reply));
    }
    const a = ((await route("u5", "GET", "")).body.agents as ag.Agent[])[0]!;
    eq([a.role, a.ready], ["", false], "still greyed out");
  });
  await ok("with a conversation named, the whole exchange is kept in it, in order, and it becomes the agent's", async () => {
    const id = ((await route("u6", "GET", "")).body.agents as ag.Agent[])[0]!.id;
    await session("sess_ident1", "u6");
    const r = await route("u6", "POST", `${id}/identity`, { text: "Take care of my real estate business", sessionId: "sess_ident1" });
    eq(r.body.saved, true);
    const msgs = await sql.query<{ role: string; content: string }>(
      "SELECT role, content FROM buzzy_chat_messages WHERE session_id = 'sess_ident1' AND user_id = 'u6' ORDER BY created_at, id");
    eq(msgs.map((m) => m.role), ["assistant", "user", "assistant"]);
    truthy(msgs[0]!.content.startsWith("What role do you want me to play?"), "starts from the agent's question");
    eq(msgs[1]!.content, "Take care of my real estate business");
    eq(msgs[2]!.content, "Got it. From now on I help with real estate business. Tell me what you need.");
    eq((await ag.agentForSession(sql, "u6", "sess_ident1"))?.id, id, "the conversation is the agent's");
    eq(((await route("u6", "GET", "")).body.agents as ag.Agent[])[0]!.lastSessionId, "sess_ident1", "and it is the one to carry on with");
    // A second answer in the same conversation adds to it; the question is not repeated.
    await route("u6", "POST", `${id}/identity`, { text: "please", sessionId: "sess_ident1" });
    const more = await sql.query<{ role: string }>("SELECT role FROM buzzy_chat_messages WHERE session_id = 'sess_ident1' ORDER BY created_at, id");
    eq(more.map((m) => m.role), ["assistant", "user", "assistant", "user", "assistant"]);
  });
  await ok("another person's conversation, or none, keeps nothing and tags nothing", async () => {
    const id = ((await route("u7", "GET", "")).body.agents as ag.Agent[])[0]!.id;
    await session("sess_theirs", "u8");
    for (const sid of ["sess_theirs", "sess_nobody", "../x", 12]) {
      const r = await route("u7", "POST", `${id}/identity`, { text: "calendars", sessionId: sid });
      eq([r.status, r.body.saved], [200, true], JSON.stringify(sid));
    }
    eq(await count("buzzy_chat_messages", "u7"), 0, "u7 stored no messages");
    eq((await sql.query<{ n: number }>("SELECT count(*)::int AS n FROM buzzy_chat_messages WHERE session_id = 'sess_theirs'"))[0]!.n, 0);
    eq((await sql.query<{ agent_id: string | null }>("SELECT agent_id FROM buzzy_sessions WHERE id = 'sess_theirs'"))[0]!.agent_id, null, "u8's conversation was not tagged");
  });
  await ok("giving a job again says it changed jobs", async () => {
    const id = ((await route("u7", "GET", "")).body.agents as ag.Agent[])[0]!.id;
    const r = await route("u7", "POST", `${id}/identity`, { text: "help me with recipes" });
    eq(r.body.reply, "Okay, I've changed jobs. From now on I help with recipes. Tell me what you need.");
    eq((r.body.agent as ag.Agent).face, "🍳");
  });

  console.log("\nTheir own, and no one else's\n");

  await ok("another account's agent is answered like one that does not exist", async () => {
    const mine = ((await route("u9", "GET", "")).body.agents as ag.Agent[])[0]!.id;
    const missing = "ag_zzzzzzzzzzzz";
    for (const [method, rest, body] of [["PATCH", "", { name: "x" }], ["DELETE", "", undefined], ["POST", "/identity", { text: "calendars" }]] as Array<[string, string, unknown]>) {
      const theirs = await route("u10", method, mine + rest, body);
      const nothing = await route("u10", method, missing + rest, body);
      eq([theirs.status, theirs.body], [nothing.status, nothing.body], `${method} ${rest}`);
      eq(theirs.status, 404);
    }
    eq(((await route("u9", "GET", "")).body.agents as ag.Agent[])[0]!.name, "Bunnyzilla", "untouched");
    eq(((await route("u10", "GET", "")).body.agents as ag.Agent[]).some((a) => a.id === mine), false, "not in their list");
    eq(await ag.agentForSession(sql, "u10", "sess_ident1"), null, "nor through a conversation");
  });
  await ok("odd paths and methods are refused plainly", async () => {
    eq((await route("u1", "PUT", "")).status, 405);
    eq((await route("u1", "DELETE", "")).status, 405);
    eq((await route("u1", "GET", "ag_abcdefghijkl")).status, 405);
    eq((await route("u1", "GET", "ag_abcdefghijkl/identity")).status, 405);
    eq((await route("u1", "PATCH", "../etc")).status, 404);
    eq((await route("u1", "PATCH", "x".repeat(200), { name: "x" })).status, 404);
    eq((await route("u1", "POST", "ag_abcdefghijkl/other", {})).status, 404);
    eq((await route("u1", "POST", "", "not an object")).status, 201, "a body that is not an object means 'the defaults'");
  });
  await ok("closing an account removes its agents and the starter marker, and no one else's", async () => {
    for (const t of ["buzzy_agents", "buzzy_agent_seed"]) truthy(DELETION_STATEMENTS[t], `${t} is not removed with the account`);
    await route("ubye", "GET", "");
    await route("ubye", "POST", "", {});
    const before = [await count("buzzy_agents", "u1"), await count("buzzy_agent_seed", "u1")];
    const receipt = await deleteAccountData(sql, "ubye");
    eq([receipt.buzzy_agents, receipt.buzzy_agent_seed], [2, 1], "the receipt counts them");
    eq([await count("buzzy_agents", "ubye"), await count("buzzy_agent_seed", "ubye")], [0, 0]);
    eq([await count("buzzy_agents", "u1"), await count("buzzy_agent_seed", "u1")], before, "u1's untouched");
  });
  await ok("a conversation's agent: found for a tagged one, none for plain, foreign or deleted; the latest is the one to carry on with", async () => {
    const a = ((await route("u11", "GET", "")).body.agents as ag.Agent[])[0]!;
    await session("sess_plain", "u11");
    await session("sess_old", "u11", a.id);
    await session("sess_new", "u11", a.id);
    await sql.query("UPDATE buzzy_sessions SET updated_at = now() - interval '2 hours' WHERE id = 'sess_old'");
    eq((await ag.agentForSession(sql, "u11", "sess_new"))?.name, "Bunnyzilla");
    eq(await ag.agentForSession(sql, "u11", "sess_plain"), null);
    eq(await ag.agentForSession(sql, "u12", "sess_new"), null, "not someone else's");
    eq(await ag.agentForSession(sql, "u11", "sess_nobody"), null);
    eq(await ag.agentForSession(sql, "u11", ""), null);
    eq(((await route("u11", "GET", "")).body.agents as ag.Agent[])[0]!.lastSessionId, "sess_new");
    eq(await ag.ownsAgent(sql, "u11", a.id), true);
    eq(await ag.ownsAgent(sql, "u12", a.id), false);
    eq(await ag.ownsAgent(sql, "u11", "not-an-id"), false);
    await route("u11", "DELETE", a.id);
    eq(await ag.agentForSession(sql, "u11", "sess_new"), null, "a deleted agent speaks no more");
  });

  console.log("\nWhat an agent says, and what it is told\n");

  // One persona since one mode (oneMode.ts). The old Work persona opened with a comma
  // ("You are BeeZilla, a …"); personaFor still handles that opening, so a stand-in keeps it checked.
  const { ONE_PERSONA } = await import("../src/lib/buzzy/oneMode");
  const chat = ONE_PERSONA;
  const work = "You are BeeZilla, a no-nonsense project manager who turns a client's problem into a clear, actionable scope of work.";
  const bunny: ag.AgentTurn = { id: "ag_x", name: "Bunnyzilla", role: "to-do list", instructions: "You're in charge of my \"to-do\" list", face: "✅" };
  await ok("the persona is the agent's: the name replaces BeeZilla's and every rule after it stays", () => {
    eq(ag.personaFor(null, chat), chat, "no agent: unchanged");
    eq(ag.personaFor(undefined, work), work);
    const c = ag.personaFor(bunny, chat);
    truthy(c.startsWith("You are Bunnyzilla, one of the person's Zilla agents (a dedicated helper from the BeeZilla family). There is one way of working here"), c.slice(0, 160));
    eq(c.slice(c.indexOf("There is one way of working")), chat.slice(chat.indexOf("There is one way of working")), "the rest is the same");
    const w = ag.personaFor(bunny, work);
    truthy(w.startsWith("You are Bunnyzilla, one of the person's Zilla agents (a dedicated helper from the BeeZilla family) and a no-nonsense project manager"), w.slice(0, 200));
    truthy(!/^You are BeeZilla/.test(c) && !/^You are BeeZilla/.test(w));
    truthy(ag.personaFor(bunny, "Be helpful.").startsWith("You are Bunnyzilla, one of the person's Zilla agents"), "a persona with no opening still gets one");
  });
  await ok("the job block names the agent and its job, quotes the person's words as theirs, and keeps it in character", () => {
    const b = ag.agentIdentityBlock(bunny);
    truthy(/YOUR JOB AS Bunnyzilla/.test(b) && /Your job: to-do list\./.test(b), b);
    truthy(/In their own words[^"]*: "You're in charge of my 'to-do' list"/.test(b), "their words, quotes made safe: " + b);
    truthy(/never as BeeZilla/.test(b) && /executive assistant who looks after all their agents/.test(b), b);
    truthy(!/In their own words/.test(ag.agentIdentityBlock({ ...bunny, instructions: "to-do list" })), "not repeated when it is only the job");
    const none = ag.agentIdentityBlock({ ...bunny, role: "", instructions: "" });
    truthy(/don't have a job yet/.test(none) && /never as BeeZilla/.test(none), none);
  });
  await ok("BeeZilla's own turns list the agents that have a job; with none she is told nothing", () => {
    eq(ag.agentsRosterBlock([]), "");
    eq(ag.agentsRosterBlock([{ name: "Bunnyzilla", role: "" }]), "", "an agent with no job is not listed");
    const r = ag.agentsRosterBlock([{ name: "Bunnyzilla", role: "calendars" }, { name: "Blue Frogzilla", role: "trips" }, { name: "Idle", role: "" }]);
    truthy(r.includes("- Bunnyzilla: helps with calendars\n- Blue Frogzilla: helps with trips"), r);
    truthy(!r.includes("Idle"), r);
    truthy(/executive assistant/.test(r) && /sidebar on the left/.test(r) && /can't do that yet/.test(r), "no claim of a hand-over");
    const many = ag.agentsRosterBlock(Array.from({ length: 25 }, (_, i) => ({ name: `Zilla ${i + 1}`, role: "things" })));
    eq((many.match(/^- Zilla /gm) || []).length, 20, "twenty lines");
    truthy(many.includes("…and 5 more."), many);
  });
  await ok("a person with no agents gets exactly the persona they got before, and nothing added", () => {
    eq(ag.agentPromptParts(null, chat, []), { persona: chat, section: "" });
    eq(ag.agentPromptParts(undefined, work, []), { persona: work, section: "" });
    eq(ag.agentPromptParts(null, chat, [{ name: "Quiet", role: "" }]), { persona: chat, section: "" }, "greyed-out agents change nothing");
    const spoken = ag.agentPromptParts(bunny, chat, [{ name: "Other", role: "x" }]);
    truthy(spoken.persona !== chat && spoken.section.includes("YOUR JOB AS Bunnyzilla") && !spoken.section.includes("Other"), "an agent's turn does not list agents");
  });

  console.log("\nThrough the real chat loop, against a stand-in model\n");

  const turn = async (user: string, sessionId: string, message = "What should I do first today?") => {
    prompts.length = 0;
    const r = await server.chatLoop({ userId: user, jobId: null, sessionId, message, mode: "chat", agent: await ag.agentForSession(sql, user, sessionId) });
    truthy(r.ok, `the turn ran: ${r.error || ""}`);
    const spoken = prompts.filter((p) => /YOUR JOB AS|You are /.test(p));
    truthy(spoken.length >= 1, "the stand-in saw the persona");
    return spoken.sort((a, b) => b.length - a.length)[0]!;
  };
  await ok("a conversation with an agent is spoken by it: its name and job are in what the model is sent", async () => {
    const id = ((await route("uchat", "GET", "")).body.agents as ag.Agent[])[0]!.id;
    await route("uchat", "POST", `${id}/identity`, { text: "You're in charge of my to-do list" });
    await session("sess_chat1", "uchat", id);
    const system = await turn("uchat", "sess_chat1");
    truthy(system.startsWith("You are Bunnyzilla, one of the person's Zilla agents"), system.slice(0, 120));
    truthy(!/You are BeeZilla/.test(system), "it does not speak as BeeZilla");
    truthy(system.includes("YOUR JOB AS Bunnyzilla") && system.includes("Your job: to-do list."), "its job is in the prompt");
    truthy(!system.includes("THE PERSON'S ZILLA AGENTS"), "an agent is not given the agent list");
  });
  await ok("BeeZilla's own conversation lists the agents that have a job, and an agent with no job is left out", async () => {
    await route("uchat", "POST", "", { creature: "frog" }); // Frogzilla, no job yet
    await session("sess_chat2", "uchat");
    const system = await turn("uchat", "sess_chat2");
    truthy(system.startsWith("You are BeeZilla."), system.slice(0, 60));
    truthy(system.includes("THE PERSON'S ZILLA AGENTS") && system.includes("- Bunnyzilla: helps with to-do list"), "the agent with a job is listed");
    truthy(!system.includes("Frogzilla"), "the one with no job is not");
  });
  await ok("a person with no agents is sent exactly the prompt they were before: nothing about agents at all", async () => {
    await session("sess_chat3", "unone");
    const system = await turn("unone", "sess_chat3");
    truthy(system.startsWith("You are BeeZilla."), system.slice(0, 60));
    truthy(!/ZILLA AGENTS|YOUR JOB AS|Zilla agent/.test(system), "no mention of agents");
    // The persona and what follows it are the same text the loop sent before agents existed.
    eq(system.slice(0, chat.length), chat);
  });
  await ok("the conversation decides, not the request: a plain conversation stays BeeZilla's even if it names an agent", async () => {
    const id = ((await route("uchat", "GET", "")).body.agents as ag.Agent[])[0]!.id;
    await session("sess_chat4", "uchat");
    prompts.length = 0;
    // The chat route looks the agent up from the session (agentForSession), so a plain session has none.
    eq(await ag.agentForSession(sql, "uchat", "sess_chat4"), null);
    const r = await server.chatLoop({ userId: "uchat", jobId: null, sessionId: "sess_chat4", message: "hello there", mode: "chat", agent: null });
    truthy(r.ok);
    truthy(prompts.some((p) => p.startsWith("You are BeeZilla.")), "BeeZilla answered");
    truthy(!prompts.some((p) => p.includes("YOUR JOB AS")), `agent ${id} did not leak in`);
  });

  console.log("\nThrough the real /api/buzzy handler, signed in\n");

  process.env.BZ_DEFAULT_PLAN = "pro";
  const { handleAuthRequest } = await import("../src/lib/auth/server");
  const { latestDevMailFor } = await import("../src/lib/mailer");
  const nitro = (await import("../src/lib/buzzy/chat.nitro")).default;
  const ORIGIN = "http://127.0.0.1:8090";
  const app = new H3();
  app.all("/**", nitro as never);
  const signIn = async (email: string) => {
    const sent = await handleAuthRequest(new Request(`${ORIGIN}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, accept: "application/json" },
      body: JSON.stringify({ email, callbackURL: "/buzzy/talk" }),
    }));
    truthy(sent.ok, `magic link send: ${sent.status}`);
    const link = latestDevMailFor(email)?.actionUrl;
    truthy(link, "magic link captured in the dev inbox");
    const verified = await handleAuthRequest(new Request(link!, { headers: { accept: "text/html" } }));
    const cookie = verified.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => /session_token=./.test(c) || /session_data=./.test(c)).join("; ");
    truthy(/session_token=/.test(cookie), `the link signs in (status ${verified.status})`);
    return cookie;
  };
  const call = async (cookie: string | null, method: string, path: string, body?: unknown, raw?: string) => {
    const headers: Record<string, string> = { host: "127.0.0.1:8090", "content-type": "application/json" };
    if (cookie) headers.cookie = cookie;
    const res = await app.fetch(new Request(ORIGIN + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }));
    let json: Record<string, any> = {};
    try { json = JSON.parse(await res.text()); } catch { /* not JSON */ }
    return { status: res.status, json };
  };
  const stamp = Date.now();
  const alice = await signIn(`alice-${stamp}@example.com`);
  const bob = await signIn(`bob-${stamp}@example.com`);
  let aliceBunny = "";
  let agentSession = "";
  let plainSession = "";

  await ok("signed out, the agents are not shown; signed in, a person sees BeeZilla, the bunny and what + adds next", async () => {
    const out = await call(null, "GET", "/api/buzzy/agents");
    eq([out.status, out.json.code], [401, "signed_out"]);
    const mine = await call(alice, "GET", "/api/buzzy/agents");
    eq(mine.status, 200);
    eq(mine.json.agents.map((a: ag.Agent) => a.name), ["Bunnyzilla"]);
    eq([mine.json.bzilla.name, mine.json.next.name, mine.json.colors.length], ["BeeZilla", "Bullzilla", 12]);
    aliceBunny = mine.json.agents[0].id;
    const his = await call(bob, "GET", "/api/buzzy/agents");
    eq(his.json.agents.map((a: ag.Agent) => a.name), ["Bunnyzilla"]);
    truthy(his.json.agents[0].id !== aliceBunny, "their own bunny");
  });
  await ok("add, change and remove work over HTTP, and another account cannot touch yours", async () => {
    const added = await call(alice, "POST", "/api/buzzy/agents", { creature: "frog", look: "teal", name: "Pond" });
    eq([added.status, added.json.agent.name, added.json.agent.color], [201, "Pond", ag.colorOf("teal")!.hex]);
    const patched = await call(alice, "PATCH", `/api/buzzy/agents/${added.json.agent.id}`, { size: "l" });
    eq([patched.status, patched.json.agent.size], [200, "l"]);
    const theirs = await call(bob, "PATCH", `/api/buzzy/agents/${added.json.agent.id}`, { name: "Mine now" });
    const nothing = await call(bob, "PATCH", "/api/buzzy/agents/ag_zzzzzzzzzzzz", { name: "Mine now" });
    eq(theirs.status, 404);
    eq(theirs.json, nothing.json, "the same answer as for one that does not exist");
    eq((await call(bob, "DELETE", `/api/buzzy/agents/${added.json.agent.id}`)).status, 404);
    eq((await call(alice, "DELETE", `/api/buzzy/agents/${added.json.agent.id}`)).status, 200);
  });
  await ok("a body over 16 KB is refused with a plain reason; bad JSON is refused; nothing is changed by either", async () => {
    const big = await call(alice, "POST", "/api/buzzy/agents", { name: "x", pad: "y".repeat(ag.AGENT_BODY_MAX_BYTES + 10) });
    eq([big.status, big.json.code], [413, "too_big"]);
    truthy(/few sentences/.test(big.json.error), big.json.error);
    const bad = await call(alice, "POST", "/api/buzzy/agents", undefined, "{not json");
    eq([bad.status, bad.json.code], [400, "bad_json"]);
    const len = await app.fetch(new Request(ORIGIN + "/api/buzzy/agents", { method: "POST", headers: { host: "127.0.0.1:8090", cookie: alice, "content-type": "application/json", "content-length": String(ag.AGENT_BODY_MAX_BYTES + 1) }, body: "{}" }));
    eq(len.status, 413, "a declared size over the cap is refused before it is read");
    eq(((await call(alice, "GET", "/api/buzzy/agents")).json.agents as unknown[]).length, 1, "still only the bunny");
  });
  await ok("a conversation can be started with an agent; only the person's own agent, and it is listed with it", async () => {
    const told = await call(alice, "POST", `/api/buzzy/agents/${aliceBunny}/identity`, { text: "Take care of my real estate business" });
    eq([told.status, told.json.saved, told.json.agent.face], [200, true, "🏠"]);
    const made = await call(alice, "POST", "/api/buzzy/sessions", { agentId: aliceBunny, fresh: true });
    eq([made.status, made.json.session.agentId], [201, aliceBunny]);
    agentSession = made.json.session.id;
    const plain = await call(alice, "POST", "/api/buzzy/sessions", { fresh: true });
    eq([plain.status, plain.json.session.agentId], [201, null]);
    plainSession = plain.json.session.id;
    const foreign = await call(bob, "POST", "/api/buzzy/sessions", { agentId: aliceBunny, fresh: true });
    eq([foreign.status, foreign.json.code], [400, "bad_agent"]);
    const nope = await call(alice, "POST", "/api/buzzy/sessions", { agentId: "ag_nonexistent1", fresh: true });
    eq(nope.status, 400);
    const list = await call(alice, "GET", "/api/buzzy/sessions");
    const byId = Object.fromEntries(list.json.sessions.map((x: { id: string; agentId: string | null }) => [x.id, x.agentId]));
    eq([byId[agentSession], byId[plainSession]], [aliceBunny, null], "each conversation says whose it is");
    eq(((await call(alice, "GET", "/api/buzzy/agents")).json.agents as ag.Agent[]).find((a) => a.id === aliceBunny)!.lastSessionId, agentSession);
  });
  await ok("resuming never mixes the two: a plain request is not handed an agent's conversation, nor an agent's a plain one", async () => {
    const plain = await call(alice, "POST", "/api/buzzy/sessions", {});
    eq([plain.json.resumed, plain.json.session.id, plain.json.session.agentId], [true, plainSession, null]);
    const mine = await call(alice, "POST", "/api/buzzy/sessions", { agentId: aliceBunny });
    eq([mine.json.resumed, mine.json.session.id, mine.json.session.agentId], [true, agentSession, aliceBunny]);
    const fresh = await call(bob, "POST", "/api/buzzy/sessions", {});
    eq(fresh.status, 201, "someone with neither starts one");
  });
  await ok("talking in the agent's conversation: the model is sent the agent's job; the reply is stored; History says whose it is", async () => {
    prompts.length = 0;
    const r = await call(alice, "POST", "/api/buzzy/chat", { sessionId: agentSession, message: "What should I check on this week?", mode: "chat" });
    eq([r.status, r.json.ok], [200, true]);
    const system = prompts.find((p) => p.includes("YOUR JOB AS")) ?? "";
    truthy(system.startsWith("You are Bunnyzilla, one of the person's Zilla agents"), system.slice(0, 100));
    truthy(system.includes("Your job: real estate business."), "its job is in the prompt");
    truthy(system.includes("Take care of my real estate business"), "and the person's own words");
    const tr = await call(alice, "GET", `/api/buzzy/transcript?sessionId=${agentSession}`);
    eq(tr.json.agentId, aliceBunny, "History can carry on as the agent");
    eq(tr.json.messages.map((m: { role: string }) => m.role), ["user", "assistant"]);
    eq((await call(alice, "GET", `/api/buzzy/transcript?sessionId=${plainSession}`)).json.agentId, null);
  });
  await ok("the conversation decides, not the request: naming an agent in a plain conversation changes nothing", async () => {
    prompts.length = 0;
    const r = await call(alice, "POST", "/api/buzzy/chat", { sessionId: plainSession, message: "Hello there", mode: "chat", agentId: aliceBunny, agent: { name: "Sneaky", role: "anything" } });
    eq([r.status, r.json.ok], [200, true]);
    truthy(prompts.some((p) => p.startsWith("You are BeeZilla.")), "BeeZilla answered");
    truthy(!prompts.some((p) => p.includes("YOUR JOB AS") || p.includes("Sneaky")), "no agent leaked in");
    truthy(prompts.some((p) => p.includes("- Bunnyzilla: helps with real estate business")), "and she knows who the agents are");
  });
  await ok("another account's conversation never speaks as your agent", async () => {
    prompts.length = 0;
    const r = await call(bob, "POST", "/api/buzzy/chat", { sessionId: agentSession, message: "Hi", mode: "chat" });
    truthy(r.status === 200 || r.status === 404 || r.status === 400, `status ${r.status}`);
    truthy(!prompts.some((p) => p.includes("YOUR JOB AS") || p.includes("real estate business")), "bob never got alice's agent");
  });

  model.close();
  console.log(`\nagents: ${pass} checks passed${fail ? `, ${fail} FAILED` : ""}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
