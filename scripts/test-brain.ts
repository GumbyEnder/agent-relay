/**
 * The brain, Code Monkey, and BeeZilla making agents (owner, 2026-11-23).
 *
 *   - The map (brainMap.ts): the three branches and the core, each with one colour and one shape
 *     that is never a privacy mode's; the copies in brain.js and agents.js match it; subjects,
 *     skills by use, asset kinds, clean paths, an agent's folders from its job.
 *   - Code Monkey: every account starts with it right under BeeZilla, ready (job: coding), in its
 *     own picture and #B8591F, with its folders; made once even when first visits race, never
 *     back after it is removed, on top of an account that already has agents; a deployment can
 *     leave it (or the bunny) out; + never hands out a monkey.
 *   - The tree: knowledge by subject (a fact by its job first), systems (each bot's agent.md and
 *     picture, skills under every use, recipes), assets by kind; A to Z; the tidy splits a big
 *     folder by job and runs on its cadence (a day, or 20 new things), places new things without
 *     moving the rest, and never moves what the person placed; folders the person makes and
 *     removes; moves that would cross a branch are refused.
 *   - Which folder each turn was about (touches), an agent's panel (its folders lit on top, the
 *     rest grey, its History) and a folder's page (who works there, recent conversations).
 *   - make_agent: offered to BeeZilla only when the person asks for an agent; it makes one with a
 *     job, a face and folders, notes it in the Hive, and is checked through the real chat loop.
 *   - Everything through the real /api/buzzy handler, signed in; another account's agents,
 *     folders and things are answered as if they were not there; closing an account removes it all.
 *
 * Hermetic: every migration on an in-memory PGlite and a local stand-in for the model.
 *   npx tsx scripts/test-brain.ts          (BRAIN_SHOW=1 prints a real tree)
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { H3 } from "h3";
import * as map from "../src/lib/buzzy/brainMap";

delete process.env.DATABASE_URL;
// Both starters, as a real account has them (the default).
delete process.env.BZ_STARTER_AGENTS;

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

// ── A stand-in model: records every request; answers by rule ────────────────
interface Msg { role?: string; content?: string }
interface Call { system: string; user: string; messages: Msg[]; tools: string[] }
interface Reply { content?: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> }
const calls: Call[] = [];
let rules: Array<{ when: (c: Call) => boolean; reply: Reply }> = [];
const model = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed: { stream?: boolean; messages?: Msg[]; tools?: Array<{ function?: { name?: string } }> } = {};
    try { parsed = JSON.parse(body || "{}"); } catch { /* not JSON */ }
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const users = messages.filter((m) => m.role === "user");
    const call: Call = {
      system: messages.filter((m) => m.role === "system").map((m) => String(m.content ?? "")).join("\n"),
      user: String(users[users.length - 1]?.content ?? ""),
      messages,
      tools: (parsed.tools ?? []).map((t) => String(t.function?.name ?? "")),
    };
    calls.push(call);
    const reply = rules.find((r) => r.when(call))?.reply ?? { content: "Happy to help with that." };
    if (parsed.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply.content ?? "" } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      model: "stand-in",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: reply.content ?? "",
          ...(reply.toolCalls ? { tool_calls: reply.toolCalls.map((t, i) => ({ id: `call_${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } })) } : {}),
        },
        finish_reason: reply.toolCalls ? "tool_calls" : "stop",
      }],
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
  const ag = await import("../src/lib/buzzy/agents");
  const br = await import("../src/lib/buzzy/brain");
  const orc = await import("../src/lib/buzzy/orchestrate");
  const reg = await import("../src/lib/buzzy/toolRegistry");
  const server = await import("../src/lib/buzzy/server");
  const { deleteAccountData, DELETION_STATEMENTS, buildExportBundle } = await import("../src/lib/buzzy/portability");

  const agents = async (user: string) => (await ag.listAgents(sql, user)).agents;
  const count = async (table: string, user: string) =>
    Number(((await sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [user]))[0] as { n: number }).n);
  const session = async (id: string, user: string, agentId: string | null = null, title = "New session", summary: string | null = null, jobId: string | null = null) => {
    await sql.query("INSERT INTO buzzy_sessions (id, user_id, agent_id, title, summary, job_id) VALUES ($1, $2, $3, $4, $5, $6)", [id, user, agentId, title, summary, jobId]);
  };
  const job = async (id: string, user: string, title: string) => {
    await sql.query("INSERT INTO buzzy_jobs (id, user_id, title) VALUES ($1, $2, $3)", [id, user, title]);
  };
  const fact = async (user: string, jobId: string | null, key: string, value: string) => {
    await sql.query("INSERT INTO buzzy_user_memory (user_id, job_id, key, value) VALUES ($1, $2, $3, $4)", [user, jobId, key, value]);
  };
  const file = async (user: string, name: string, type: string, jobId: string | null = null) => {
    const rows = await sql.query<{ id: number }>(
      "INSERT INTO buzzy_assets (user_id, sha256, filename, rel_path, content_type, bytes, body, job_id) VALUES ($1, $2, $3, $3, $4, 3, $5, $6) RETURNING id",
      [user, `${user}-${name}-${Math.random()}`, name, type, Buffer.from("abc"), jobId]);
    return rows[0]!.id;
  };

  console.log("\nThe map\n");

  await ok("brain, knowledge, systems and assets: a colour and a shape each, none of them a privacy mode's colour", () => {
    eq([map.ROOT.label, map.ROOT.shape, map.ROOT.color], ["brain", "hexagon", "#F472B6"]);
    eq(map.BRANCHES.map((b) => [b.id, b.shape, b.color]), [["knowledge", "circle", "#4DA3FF"], ["systems", "square", "#2DD4BF"], ["assets", "triangle", "#A78BFA"]]);
    const modes = ["#2E9E5B", "#FFC107", "#E5484D", "#FFD40D"];
    for (const c of [map.ROOT.color, ...map.BRANCHES.map((b) => b.color)]) truthy(!modes.includes(c.toUpperCase()), `${c} is a mode colour`);
    eq(new Set([map.ROOT.shape, ...map.BRANCHES.map((b) => b.shape)]).size, 4, "four different shapes");
  });
  await ok("the copies of the colours and shapes in brain.js and agents.js are the map's", () => {
    for (const f of ["public/buzzy/brain.js", "public/buzzy/agents.js"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      for (const b of [{ id: "brain", color: map.ROOT.color, shape: map.ROOT.shape }, ...map.BRANCHES]) {
        const re = new RegExp(`${b.id}: \\{ color: "${b.color}", shape: "${b.shape}"`);
        truthy(re.test(src), `${f}: ${b.id} is not ${b.color} ${b.shape}`);
      }
    }
  });
  await ok("subjects: the specific before the general, and nothing in particular is general", () => {
    const cases: Array<[string, string]> = [
      ["Fix the login bug in my app's TypeScript", "programming"],
      ["Make my website's landing page faster", "web-design"],
      ["Kitchen remodel", "home"],
      ["What are the closing costs on the condo listing?", "real-estate"],
      ["Plan a trip to Lisbon", "travel"],
      ["Write a lullaby for my daughter", "music"],
      ["hi", "general"],
      ["", "general"],
    ];
    for (const [text, want] of cases) eq(map.subjectOf(text), want, text);
    eq(map.SUBJECTS.map((s) => s.id).indexOf("web-design") < map.SUBJECTS.map((s) => s.id).indexOf("programming"), true, "web design is tried first");
  });
  await ok("paths: cleaned, always under a branch, plain names only, never deeper than six", () => {
    eq(map.cleanPath("brain/Knowledge//Home/"), "knowledge/home");
    eq(map.cleanPath("/assets/pictures"), "assets/pictures");
    eq(map.cleanPath("knowledge/../systems"), null, "no climbing out");
    eq(map.cleanPath("knowledge/a b"), null, "no spaces");
    eq(map.cleanPath("downloads/x"), null, "not a branch");
    eq(map.cleanPath("knowledge/a/b/c/d/e"), "knowledge/a/b/c/d/e");
    eq(map.cleanPath("knowledge/a/b/c/d/e/f"), null, "seven deep");
    eq(map.cleanPath(42), null);
    eq(map.slug("Kitchen Remodel!"), "kitchen-remodel");
    eq(map.slug("Café & Bar"), "cafe-and-bar");
    eq(map.within("knowledge/home/deck", "knowledge/home"), true);
    eq(map.within("knowledge/homework", "knowledge/home"), false, "a prefix of the name is not inside");
  });
  await ok("an agent's folders from its job: its subject's knowledge, and its skills when there are skills for it", () => {
    eq(map.domainsForJob("coding"), ["knowledge/programming", "systems/skills/programming"]);
    eq(map.domainsForJob("my real estate business"), ["knowledge/real-estate"]);
    eq(map.domainsForJob("my taxes"), ["knowledge/money"]);
    eq(map.domainsForJob("bee keeping"), ["knowledge/bee-keeping"], "a job with no subject gets a folder of its own");
    eq(map.domainsForJob(""), []);
    eq(map.cleanDomains(["knowledge/home", "knowledge/home", "nope", 3, "assets/videos"]), ["knowledge/home", "assets/videos"]);
    eq(map.cleanDomains("knowledge/home"), null, "a list, not a word");
  });
  await ok("skills are filed under every use they have; every use has a skill; programming and web design are not empty", () => {
    const uses = new Set(map.PURPOSES.map((p) => p.id));
    for (const s of map.SKILLS) for (const u of s.uses) truthy(uses.has(u), `${s.id} uses ${u}, which is not a folder`);
    for (const p of map.PURPOSES) truthy(map.SKILLS.some((s) => s.uses.includes(p.id)), `nothing in ${p.id}`);
    truthy(map.SKILLS.filter((s) => s.uses.includes("programming")).length >= 2, "programming skills");
    truthy(map.SKILLS.filter((s) => s.uses.includes("web-design")).length >= 2, "web design skills");
    eq(map.PURPOSES.map((p) => p.label), [...map.PURPOSES.map((p) => p.label)].sort((a, b) => a.localeCompare(b)), "A to Z");
  });
  await ok("assets go by what they are", () => {
    eq(map.assetKindOf("image/png", "a.png"), "pictures");
    eq(map.assetKindOf("", "monkey-dancing.mp4"), "videos");
    eq(map.assetKindOf("audio/mpeg", ""), "music");
    eq(map.assetKindOf("model/gltf-binary", "x.glb"), "3d-models");
    eq(map.assetKindOf("application/pdf", "contract.pdf"), "files");
  });
  await ok("the tidy: a folder over twelve is split by job where three or more share one; the rest stay; small folders stay flat", () => {
    const loose = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `k${i}`, base: "knowledge/home", topic: "kitchen-remodel" })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, base: "knowledge/home", topic: "bathroom" })),
      ...Array.from({ length: 2 }, (_, i) => ({ id: `d${i}`, base: "knowledge/home", topic: "deck" })),
      ...Array.from({ length: 2 }, (_, i) => ({ id: `n${i}`, base: "knowledge/home", topic: "" })),
      ...Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, base: "knowledge/travel", topic: "lisbon" })),
    ];
    const plan = br.planTidy(loose);
    eq(plan.get("k0"), "knowledge/home/kitchen-remodel");
    eq(plan.get("b3"), "knowledge/home/bathroom");
    eq(plan.get("d0"), "knowledge/home", "two of a job stay in the subject");
    eq(plan.get("n1"), "knowledge/home");
    eq(plan.get("t0"), "knowledge/travel", "four in travel: not split");
    eq(JSON.stringify([...br.planTidy(loose)]), JSON.stringify([...plan]), "the same every time");
    eq(br.planTidy(loose.slice(0, 12)).get("k0"), "knowledge/home", "twelve is not more than twelve");
  });

  console.log("\nCode Monkey\n");

  await ok("a new person's first look: BeeZilla, then Code Monkey, ready, in its own picture and #B8591F, then the grey bunny", async () => {
    const list = await agents("m1");
    eq(list.map((a) => a.name), ["Code Monkey", "Bunnyzilla"]);
    const m = list[0]!;
    eq([m.creature, m.look, m.color, m.role, m.ready, m.face, m.image, m.size], ["monkey", "", "#B8591F", "coding", true, "", "/buzzy/zillas/monkey.webp", "m"]);
    eq(m.domains, ["knowledge/programming", "knowledge/web-design", "systems/skills/programming", "systems/skills/web-design"]);
    eq(m.opening, "Hi, I'm Code Monkey. I help with coding. What do you need?");
    eq(list[1]!.ready, false, "the bunny is still waiting for a job");
    eq(await count("buzzy_agent_starters", "m1"), 1);
  });
  await ok("five first looks at once make one Code Monkey; looking again never makes another", async () => {
    await Promise.all([1, 2, 3, 4, 5].map(() => ag.listAgents(sql, "m2")));
    await agents("m2");
    eq((await agents("m2")).filter((a) => a.creature === "monkey").length, 1);
    eq(await count("buzzy_agents", "m2"), 2);
  });
  await ok("removed, it never comes back; renamed and recoloured, it keeps its job", async () => {
    const m = (await agents("m3"))[0]!;
    const changed = await ag.agentsRoute(sql, "m3", "PATCH", m.id, { name: "Monkey Business", look: "teal" });
    eq([changed.status, (changed.body.agent as { name: string }).name, (changed.body.agent as { role: string }).role], [200, "Monkey Business", "coding"]);
    eq((changed.body.agent as { image: string }).image, "/buzzy/zillas/monkey-teal.webp");
    eq((await ag.agentsRoute(sql, "m3", "DELETE", m.id, undefined)).status, 200);
    eq((await agents("m3")).map((a) => a.name), ["Bunnyzilla"]);
    eq((await agents("m3")).map((a) => a.name), ["Bunnyzilla"], "and not on the next look either");
  });
  await ok("an account that already has agents and a colony gets Code Monkey above all of them", async () => {
    process.env.BZ_STARTER_AGENTS = "bunny";
    const [bunny] = await agents("m4");
    const frog = (await ag.agentsRoute(sql, "m4", "POST", "", { creature: "frog" })).body.agent as { id: string };
    await ag.agentsRoute(sql, "m4", "POST", "colonies", { name: "Pond", agents: [frog.id] });
    eq((await agents("m4")).map((a) => a.name), ["Bunnyzilla", "Frogzilla"]);
    delete process.env.BZ_STARTER_AGENTS;
    const after = await ag.listAgents(sql, "m4");
    eq(after.agents.map((a) => a.name), ["Code Monkey", "Bunnyzilla", "Frogzilla"]);
    eq(after.layout[0], { type: "agent", id: after.agents[0]!.id }, "first at the top level, above the colony");
    truthy(bunny, "had a bunny");
  });
  await ok("a deployment can leave out either starter (BZ_STARTER_AGENTS)", async () => {
    process.env.BZ_STARTER_AGENTS = "bunny";
    eq((await agents("m5")).map((a) => a.name), ["Bunnyzilla"]);
    process.env.BZ_STARTER_AGENTS = "code-monkey";
    eq((await agents("m6")).map((a) => a.name), ["Code Monkey"]);
    delete process.env.BZ_STARTER_AGENTS;
    eq([...ag.starterAgents()].sort(), ["bunny", "code-monkey"]);
  });
  await ok("+ never hands out a monkey, and the monkey can still be chosen", async () => {
    const have: Array<{ creature: string; look: string; name: string }> = [];
    for (let i = 0; i < 60; i++) { const d = ag.nextDefault(have); truthy(d.creature !== "monkey", `+ gave ${d.name}`); have.push(d); }
    const made = (await ag.agentsRoute(sql, "m7", "POST", "", { creature: "monkey", look: "blue" })).body.agent as { name: string; image: string };
    eq([made.name, made.image], ["Blue Monkeyzilla", "/buzzy/zillas/monkey-blue.webp"]);
  });
  await ok("its folders follow its job only while they are the job's own; the person's choice is kept", async () => {
    const list = await agents("m8");
    const bunny = list.find((a) => a.creature === "bunny")!;
    const told = await ag.setIdentity(sql, "m8", bunny.id, "I want you to help me with my taxes");
    truthy(told.ok && told.saved, "saved");
    eq((told as { agent: { domains: string[] } }).agent.domains, ["knowledge/money"]);
    const moved = await ag.agentsRoute(sql, "m8", "PATCH", bunny.id, { role: "running" });
    eq((moved.body.agent as { domains: string[] }).domains, ["knowledge/health"], "a new job, the new job's folders");
    const mine = await ag.agentsRoute(sql, "m8", "PATCH", bunny.id, { domains: ["knowledge/home", "brain/assets/videos"] });
    eq((mine.body.agent as { domains: string[] }).domains, ["knowledge/home", "assets/videos"]);
    const kept = await ag.agentsRoute(sql, "m8", "PATCH", bunny.id, { role: "travel" });
    eq((kept.body.agent as { domains: string[] }).domains, ["knowledge/home", "assets/videos"], "chosen by the person: kept");
    const monkey = list.find((a) => a.creature === "monkey")!;
    const job = await ag.agentsRoute(sql, "m8", "PATCH", monkey.id, { role: "writing" });
    eq((job.body.agent as { domains: string[] }).domains, ag.CODE_MONKEY.domains, "Code Monkey's starter folders are its own, not its job's");
    const bad = await ag.agentsRoute(sql, "m8", "PATCH", bunny.id, { domains: "knowledge/home" });
    eq([bad.status, bad.body.code], [400, "bad_domains"]);
  });

  console.log("\nThe tree\n");

  const T0 = new Date("2026-11-23T10:00:00Z");
  const hours = (h: number) => new Date(T0.getTime() + h * 3600000);
  await job("job_kitchen", "u1", "Kitchen remodel");
  await job("job_bath", "u1", "Bathroom");
  await job("job_deck", "u1", "Deck");
  for (const k of ["budget", "deadline", "cabinets", "floor", "lights"]) await fact("u1", "job_kitchen", k, `kitchen ${k}`);
  for (const k of ["budget", "tiles", "tub", "fan"]) await fact("u1", "job_bath", k, `bath ${k}`);
  for (const k of ["budget", "wood"]) await fact("u1", "job_deck", k, `deck ${k}`);
  await fact("u1", null, "favorite_language", "TypeScript, for the website and the app");
  await file("u1", "monkey-dancing.mp4", "video/mp4");
  await file("u1", "logo.png", "image/png", "job_kitchen");
  await ag.listAgents(sql, "u1");
  const u1monkey = (await agents("u1"))[0]!;
  await session("sess_cm1", "u1", u1monkey.id, "Fix the login bug", "We traced the login bug to an expired token in the API and fixed the code.");
  await session("sess_bz1", "u1", null, "Kitchen budget", "Went over the kitchen remodel budget and the cabinet quotes.", "job_kitchen");

  let first: Awaited<ReturnType<typeof br.buildBrain>>;
  await ok("a first look files everything and tidies at once: knowledge by subject (a fact by its job), assets by kind", async () => {
    first = await br.buildBrain(sql, "u1", { now: T0 });
    const at = (id: string) => first.items.find((i) => i.id === id)?.path;
    eq(first.tidy.ran, true, "the first look tidies");
    eq(at("fact:job_kitchen:budget"), "knowledge/home", "a kitchen remodel's budget is about the home");
    eq(at("fact::favorite_language"), "knowledge/web-design");
    eq(at("chat:sess_cm1"), "knowledge/programming");
    eq(at("chat:sess_bz1"), "knowledge/home");
    const files = first.items.filter((i) => i.kind === "file").map((i) => [i.title, i.path]).sort();
    eq(files, [["logo.png", "assets/pictures"], ["monkey-dancing.mp4", "assets/videos"]]);
    eq(first.items.find((i) => i.id === "fact:job_kitchen:budget")?.sub, "From Kitchen remodel");
  });
  await ok("systems: every bot's agent.md and picture, the skills under every use, the recipes folder", () => {
    const bots = first.items.filter((i) => i.path.startsWith("systems/bots/")).map((i) => `${i.path}:${i.title}`).sort();
    eq(bots, [
      "systems/bots/beezilla:agent.md", "systems/bots/beezilla:avatar",
      "systems/bots/bunnyzilla:agent.md", "systems/bots/bunnyzilla:avatar",
      "systems/bots/code-monkey:agent.md", "systems/bots/code-monkey:avatar",
    ]);
    const md = first.items.find((i) => i.id === `bot:${u1monkey.id}:agent.md`)!;
    truthy(md.body!.startsWith("# Code Monkey\n\nHelps with: coding") && md.body!.includes("brain/knowledge/programming"), md.body);
    eq(first.items.find((i) => i.id === `bot:${u1monkey.id}:avatar`)?.url, "/buzzy/zillas/monkey.webp");
    const prog = first.items.filter((i) => i.path === "systems/skills/programming").map((i) => i.title).sort();
    eq(prog, ["Read a web page", "Search the web"]);
    truthy(first.items.some((i) => i.path === "systems/skills/research" && i.title === "Search the web"), "the same skill under research too");
    truthy(first.folders.some((f) => f.path === "systems/recipes"), "recipes");
  });
  await ok("folders: the map's always, Code Monkey's own, A to Z inside each, labels in words", () => {
    const paths = first.folders.map((f) => f.path);
    for (const p of ["knowledge", "systems", "assets", "systems/bots", "systems/skills/web-design", "assets/videos", "assets/3d-models", "knowledge/programming", "knowledge/web-design", "knowledge/home"]) {
      truthy(paths.includes(p), `${p} is missing`);
    }
    eq(paths.slice(0, 3).map((p) => p.split("/")[0]), ["knowledge", "knowledge", "knowledge"], "knowledge first, as the map orders branches");
    const knowledgeKids = first.folders.filter((f) => f.depth === 2 && f.branch === "knowledge").map((f) => f.label);
    eq(knowledgeKids, [...knowledgeKids].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())), "A to Z");
    eq(first.folders.find((f) => f.path === "systems/bots/code-monkey")?.label, "Code Monkey");
    eq(first.folders.find((f) => f.path === "knowledge/web-design")?.label, "Web design");
    eq(first.folders.find((f) => f.path === "knowledge")?.total, first.items.filter((i) => i.path.startsWith("knowledge")).length);
    if (process.env.BRAIN_SHOW) console.log(first.folders.map((f) => "  ".repeat(f.depth) + f.label + ` (${f.total})`).join("\n"));
  });
  await ok("a folder that grows past twelve is split by job at the next tidy, with the job's name", async () => {
    for (const k of ["sink", "paint", "door"]) await fact("u1", "job_kitchen", k, `kitchen ${k}`);
    // 3 new things: not 20, and not a day: placed, not tidied.
    const placed = await br.buildBrain(sql, "u1", { now: hours(1) });
    eq(placed.tidy.ran, false);
    eq(placed.items.find((i) => i.id === "fact:job_kitchen:sink")?.path, "knowledge/home");
    const tidied = await br.buildBrain(sql, "u1", { now: hours(25) });
    eq(tidied.tidy.ran, true, "a day later");
    eq(tidied.items.find((i) => i.id === "fact:job_kitchen:sink")?.path, "knowledge/home/kitchen-remodel");
    eq(tidied.items.find((i) => i.id === "fact:job_bath:tub")?.path, "knowledge/home/bathroom");
    eq(tidied.items.find((i) => i.id === "fact:job_deck:wood")?.path, "knowledge/home", "two of a job stay");
    eq(tidied.folders.find((f) => f.path === "knowledge/home/kitchen-remodel")?.label, "Kitchen remodel");
    truthy(tidied.tidy.moved >= 9, `moved ${tidied.tidy.moved}`);
    eq(tidied.tidy.next, hours(49).toISOString());
  });
  await ok("between tidies, something new goes where the tree already has a place for it, and nothing else moves", async () => {
    await fact("u1", "job_kitchen", "handles", "brass");
    const b = await br.buildBrain(sql, "u1", { now: hours(26) });
    eq(b.tidy.ran, false);
    eq(b.items.find((i) => i.id === "fact:job_kitchen:handles")?.path, "knowledge/home/kitchen-remodel");
  });
  await ok("twenty new things bring the tidy forward", async () => {
    for (let i = 0; i < 20; i++) await fact("u1", null, `trip_note_${i}`, `Lisbon trip, day ${i}`);
    const b = await br.buildBrain(sql, "u1", { now: hours(27) });
    eq(b.tidy.ran, true);
    eq(b.items.find((i) => i.id === "fact::trip_note_3")?.path, "knowledge/travel");
  });
  await ok("what the person moves stays where they put it, tidy after tidy; moves across branches are refused", async () => {
    const made = await br.makeFolder(sql, "u1", "knowledge/home", "Ideas for later");
    eq(made, { ok: true, path: "knowledge/home/ideas-for-later" });
    const moved = await br.placeItem(sql, "u1", "fact:job_deck:wood", "knowledge/home/ideas-for-later");
    eq(moved, { ok: true, path: "knowledge/home/ideas-for-later" });
    const b = await br.buildBrain(sql, "u1", { tidy: "now", now: hours(28) });
    const it = b.items.find((i) => i.id === "fact:job_deck:wood")!;
    eq([it.path, it.placedBy], ["knowledge/home/ideas-for-later", "person"]);
    const wrong = await br.placeItem(sql, "u1", "fact:job_deck:wood", "assets/videos");
    eq([wrong.ok, (wrong as { code: string }).code], [false, "wrong_branch"]);
    const nowhere = await br.placeItem(sql, "u1", "fact:job_deck:wood", "knowledge/nowhere-yet");
    eq((nowhere as { code: string }).code, "no_folder");
    const fixed = await br.placeItem(sql, "u1", `bot:${u1monkey.id}:agent.md`, "knowledge/home");
    eq((fixed as { code: string }).code, "bad_item", "a bot's agent.md is not moved");
    const back = await br.placeItem(sql, "u1", "fact:job_deck:wood", null);
    eq(back, { ok: true, path: "knowledge/home" }, "handed back to the tidy");
  });
  await ok("folders the person makes: anywhere in knowledge, assets or their recipes; removed only when empty and theirs", async () => {
    eq((await br.makeFolder(sql, "u1", "systems/bots", "Mine") as { code: string }).code, "fixed_folder");
    eq((await br.makeFolder(sql, "u1", "systems/skills/programming", "x") as { code: string }).code, "fixed_folder");
    eq((await br.makeFolder(sql, "u1", "knowledge/a/b/c/d/e", "f") as { code: string }).code, "too_deep");
    eq((await br.makeFolder(sql, "u1", "knowledge/home", "!!!") as { code: string }).code, "bad_name");
    const clip = await br.makeFolder(sql, "u1", "assets/videos", "Monkey clips");
    eq(clip, { ok: true, path: "assets/videos/monkey-clips" });
    const vid = (await br.buildBrain(sql, "u1", { tidy: "never" })).items.find((i) => i.title === "monkey-dancing.mp4")!;
    await br.placeItem(sql, "u1", vid.id, "assets/videos/monkey-clips");
    eq((await br.removeFolder(sql, "u1", "assets/videos/monkey-clips") as { code: string }).code, "not_empty");
    eq((await br.removeFolder(sql, "u1", "knowledge/home") as { code: string }).code, "not_found", "only folders they made");
    await br.placeItem(sql, "u1", vid.id, null);
    eq(await br.removeFolder(sql, "u1", "assets/videos/monkey-clips"), { ok: true });
    truthy(!(await br.buildBrain(sql, "u1", { tidy: "never" })).folders.some((f) => f.path === "assets/videos/monkey-clips"), "gone");
  });

  console.log("\nTouches, panels and folders\n");

  await ok("each turn leaves the folder it was about and who spoke; a turn about nothing leaves nothing", async () => {
    eq(await br.noteTurn(sql, "u1", { agentId: u1monkey.id, sessionId: "sess_cm1", message: "The deploy fails with a TypeScript error" }), "knowledge/programming");
    eq(await br.noteTurn(sql, "u1", { agentId: u1monkey.id, sessionId: "sess_cm1", message: "Now the API returns 500" }), "knowledge/programming");
    eq(await br.noteTurn(sql, "u1", { agentId: null, sessionId: "sess_bz1", message: "How much were the kitchen cabinets?" }), "knowledge/home");
    eq(await br.noteTurn(sql, "u1", { agentId: null, sessionId: null, message: "hi there" }), null);
    eq(await br.noteTurn(sql, "u1", { agentId: "not an id", sessionId: "../x", message: "my website" }), "knowledge/web-design");
    const rows = await sql.query<{ agent_id: string; session_id: string | null }>("SELECT agent_id, session_id FROM buzzy_brain_touches WHERE user_id = 'u1' ORDER BY id DESC LIMIT 1");
    eq([rows[0]!.agent_id, rows[0]!.session_id], ["bzilla", null], "a stranger's id is BeeZilla's, and a bad session id is none");
  });
  await ok("Code Monkey's panel: its folders lit on top (most first), the rest of the brain grey, its History", async () => {
    const p = (await br.agentPanel(sql, "u1", u1monkey.id, { now: hours(28) }))!;
    eq(p.agent, { id: u1monkey.id, name: "Code Monkey", color: "#B8591F", folder: "systems/bots/code-monkey" });
    const hot = p.folders.filter((f) => f.hot).map((f) => f.path);
    eq(hot[0], "knowledge/programming", "the most worked-in first");
    for (const h of ["knowledge/web-design", "systems/skills/programming", "systems/skills/web-design", "systems/bots/code-monkey"]) truthy(hot.includes(h), `${h} not lit`);
    const greyAt = p.folders.findIndex((f) => !f.hot);
    truthy(greyAt > 0 && p.folders.slice(greyAt).every((f) => !f.hot), "lit first, then grey");
    for (const g of ["knowledge/home", "assets/videos", "systems/skills/music", "systems/bots/beezilla"]) truthy(p.folders.some((f) => f.path === g && !f.hot), `${g} not grey`);
    eq(p.history.map((h) => h.id), ["sess_cm1"]);
    eq(p.folders.find((f) => f.path === "knowledge/programming")?.crumbs, ["knowledge", "Programming"]);
  });
  await ok("BeeZilla's panel: where she talked, lit; her own conversations in History", async () => {
    const p = (await br.agentPanel(sql, "u1", "bzilla", { now: hours(28) }))!;
    const hot = p.folders.filter((f) => f.hot).map((f) => f.path);
    truthy(hot.includes("knowledge/home") && hot.includes("systems/bots/beezilla"), hot.join());
    truthy(!hot.includes("knowledge/programming"), "not where only Code Monkey works");
    eq(p.history.map((h) => h.id), ["sess_bz1"]);
  });
  await ok("a folder: who works there (most first) and the recent conversations about it", async () => {
    const prog = (await br.folderInfo(sql, "u1", "brain/knowledge/programming", { now: hours(28) }))!;
    eq(prog.workers[0]!.name, "Code Monkey");
    eq(prog.sessions.map((s) => s.id), ["sess_cm1"]);
    eq(prog.crumbs, ["knowledge", "Programming"]);
    const home = (await br.folderInfo(sql, "u1", "knowledge/home", { now: hours(28) }))!;
    eq(home.workers[0]!.name, "BeeZilla");
    truthy(!home.workers.some((w) => w.name === "Code Monkey"), "Code Monkey does not work at home");
    eq(home.sessions.map((s) => s.id), ["sess_bz1"]);
    eq(await br.folderInfo(sql, "u1", "knowledge/../systems"), null);
    eq(await br.folderInfo(sql, "u1", "knowledge/never-made"), null);
  });
  await ok("another account's agent and folders are answered as not there", async () => {
    eq(await br.agentPanel(sql, "u2", u1monkey.id), null);
    const theirs = (await br.folderInfo(sql, "u2", "knowledge/programming"))!;
    eq(theirs.sessions, [], "u1's conversations never show");
    truthy(!theirs.workers.some((w) => w.id === u1monkey.id), "nor u1's monkey");
    eq((await br.placeItem(sql, "u2", "fact:job_kitchen:budget", "knowledge/home") as { code: string }).code, "not_found");
  });

  console.log("\nBeeZilla makes agents\n");

  await ok("make_agent is offered on BeeZilla's own written turn when the person asks for an agent, and nowhere else", () => {
    const yes = ["make me an agent for my taxes", "Can you set up a helper that tracks my runs?", "I need a new bot for emails", "create a sub-agent for research", "Spin up an assistant for my Etsy shop"];
    const no = ["what can my agents do?", "add milk to the list", "my agent is great", "how do I make bread?"];
    for (const m of yes) eq(orc.makeAgentOffer({ agent: null, message: m }), true, m);
    for (const m of no) eq(orc.makeAgentOffer({ agent: null, message: m }), false, m);
    eq(orc.makeAgentOffer({ agent: { id: "ag_x" }, message: yes[0]! }), false, "an agent never makes agents");
    eq(orc.makeAgentOffer({ agent: null, message: yes[0]!, spoken: true }), false, "a spoken turn has no tools");
  });
  await ok("the registry: make_agent sits behind the same gate as the Hive's tools, and says why when it is not offered", () => {
    const p = reg.policyFor("make_agent")!;
    eq([p.gate, p.hiveFlag, p.sideEffects, p.egress, p.cost], ["hive", "makeAgent", "writes-own-rows", false, "free"]);
    truthy(!reg.offeredToolNames({ draftGateOpen: true }).includes("make_agent"), "never always-on");
    truthy(reg.offeredToolNames({ draftGateOpen: false, hive: { makeAgent: true } }).includes("make_agent"));
    truthy(reg.offeredToolNames({ draftGateOpen: false, lockdown: true, hive: { makeAgent: true } }).includes("make_agent"), "nothing leaves BeeZilla, so Lockdown keeps it");
    truthy(/only BeeZilla herself can make a new agent/.test(reg.refusalFor("make_agent", { draftGateOpen: false }) ?? ""));
  });
  await ok("make_agent makes it with its job, face and folders, and the Hive says so", async () => {
    await agents("u5");
    const made = await orc.makeAgent(sql, "u5", { name: "Tax Owl", job: "my taxes", subjects: ["money", "legal"], words: "make me an agent for my taxes" });
    truthy(made.ok, JSON.stringify(made));
    const a = (made as { agent: { name: string; role: string; face: string; domains: string[]; instructions: string; ready: boolean } }).agent;
    eq([a.name, a.role, a.face, a.ready], ["Tax Owl", "my taxes", "🧾", true]);
    eq(a.domains, ["knowledge/money", "knowledge/legal"]);
    eq(a.instructions, "make me an agent for my taxes");
    const coder = await orc.makeAgent(sql, "u5", { job: "the website", subjects: ["web design", "bee keeping"] });
    eq((coder as { agent: { domains: string[]; name: string } }).agent.domains, ["knowledge/web-design", "systems/skills/web-design", "knowledge/bee-keeping"]);
    truthy(/zilla/.test((coder as { agent: { name: string } }).agent.name), "a default Zilla name");
    const lines = await sql.query<{ body: string; from_id: string }>("SELECT body, from_id FROM buzzy_hive_messages WHERE user_id = 'u5' ORDER BY id");
    eq(lines[0], { body: "BeeZilla made a new agent: Tax Owl, helps with my taxes", from_id: "bzilla" });
    eq((await orc.makeAgent(sql, "u5", { job: "  " }) as { code: string }).code, "no_job");
  });
  await ok("through the real chat loop: offered and explained only when asked; the agent is made and the model is told", async () => {
    await agents("u6");
    calls.length = 0;
    rules = [
      { when: (c) => c.messages.some((m) => m.role === "user" && String(m.content ?? "").startsWith("make_agent made")), reply: { content: "Done: Tax Owl now looks after your taxes." } },
      { when: (c) => c.tools.includes("make_agent"), reply: { toolCalls: [{ name: "make_agent", args: { name: "Tax Owl", job: "my taxes", subjects: ["money"] } }] } },
    ];
    await session("sess_mk", "u6");
    const r = await server.chatLoop({ userId: "u6", jobId: null, sessionId: "sess_mk", message: "Can you make me an agent for my taxes?", mode: "chat", agent: null });
    truthy(r.ok, JSON.stringify(r).slice(0, 300));
    const offered = calls.find((c) => c.tools.includes("make_agent"));
    truthy(offered, `offered (tools seen: ${JSON.stringify(calls.map((c) => c.tools))})`);
    truthy(offered!.system.includes("MAKING AGENTS") && offered!.system.includes("call make_agent"), "and explained");
    truthy(calls.some((c) => c.messages.some((m) => String(m.content ?? "").startsWith("make_agent made Tax Owl, who helps with my taxes."))), "the model is told what was made");
    truthy((await agents("u6")).some((a) => a.name === "Tax Owl" && a.role === "my taxes"), "it is in the sidebar's list");
    calls.length = 0;
    rules = [];
    await server.chatLoop({ userId: "u6", jobId: null, sessionId: "sess_mk", message: "What should I cook tonight?", mode: "chat", agent: null });
    truthy(calls.length > 0 && !calls.some((c) => c.tools.includes("make_agent") || c.system.includes("MAKING AGENTS")), "an ordinary turn: neither offered nor mentioned");
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
    truthy(link, "magic link captured");
    const verified = await handleAuthRequest(new Request(link!, { headers: { accept: "text/html" } }));
    const cookie = verified.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => /session_token=./.test(c) || /session_data=./.test(c)).join("; ");
    truthy(/session_token=/.test(cookie), "signed in");
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
  const alice = await signIn(`brain-alice-${stamp}@example.com`);
  const bob = await signIn(`brain-bob-${stamp}@example.com`);
  let aliceMonkey = "";

  await ok("signed out, no brain; signed in, the agents start with Code Monkey and the brain has its folders", async () => {
    eq((await call(null, "GET", "/api/buzzy/brain")).status, 401);
    eq((await call(null, "GET", "/api/buzzy/brain/agent/bzilla")).status, 401);
    const list = await call(alice, "GET", "/api/buzzy/agents");
    eq(list.json.agents.map((a: { name: string }) => a.name), ["Code Monkey", "Bunnyzilla"]);
    aliceMonkey = list.json.agents[0].id;
    const brain = await call(alice, "GET", "/api/buzzy/brain");
    eq(brain.status, 200);
    eq(brain.json.root.label, "brain");
    truthy(brain.json.folders.some((f: { path: string }) => f.path === "systems/bots/code-monkey"), "Code Monkey's folder");
    truthy(brain.json.items.some((i: { id: string }) => i.id === `bot:${aliceMonkey}:agent.md`), "its agent.md");
  });
  await ok("talking to Code Monkey about code lights up programming, and lists the conversation there and in its History", async () => {
    const s = await call(alice, "POST", "/api/buzzy/sessions", { agentId: aliceMonkey, fresh: true });
    eq(s.status, 201);
    const sid = s.json.session.id;
    const turn = await call(alice, "POST", "/api/buzzy/chat", { message: "Why does my TypeScript build fail?", sessionId: sid });
    eq(turn.status, 200, JSON.stringify(turn.json).slice(0, 200));
    const panel = await call(alice, "GET", `/api/buzzy/brain/agent/${aliceMonkey}`);
    eq(panel.status, 200);
    eq(panel.json.folders[0].path, "knowledge/programming");
    eq(panel.json.history.map((h: { id: string }) => h.id), [sid]);
    const folder = await call(alice, "GET", "/api/buzzy/brain/folder?path=knowledge/programming");
    eq([folder.status, folder.json.workers[0].name, folder.json.sessions[0]?.id], [200, "Code Monkey", sid]);
    eq((await call(bob, "GET", "/api/buzzy/brain/folder?path=knowledge/programming")).json.sessions, [], "never another account's");
    eq((await call(bob, "GET", `/api/buzzy/brain/agent/${aliceMonkey}`)).status, 404);
  });
  await ok("tidy now, make a folder, move a thing, remove the folder: all over HTTP", async () => {
    const tidy = await call(alice, "POST", "/api/buzzy/brain/tidy");
    eq([tidy.status, tidy.json.tidy.ran], [200, true]);
    const made = await call(alice, "POST", "/api/buzzy/brain/folders", { parent: "knowledge/programming", name: "Snippets" });
    eq([made.status, made.json.path], [201, "knowledge/programming/snippets"]);
    const brain = await call(alice, "GET", "/api/buzzy/brain");
    const chat = brain.json.items.find((i: { kind: string }) => i.kind === "conversation");
    if (chat) {
      const moved = await call(alice, "PUT", "/api/buzzy/brain/place", { item: chat.id, path: "knowledge/programming/snippets" });
      eq([moved.status, moved.json.path], [200, "knowledge/programming/snippets"]);
      eq((await call(alice, "DELETE", "/api/buzzy/brain/folders?path=knowledge/programming/snippets")).status, 409);
      await call(alice, "PUT", "/api/buzzy/brain/place", { item: chat.id, path: null });
    }
    eq((await call(alice, "DELETE", "/api/buzzy/brain/folders?path=knowledge/programming/snippets")).status, 200);
    eq((await call(bob, "DELETE", "/api/buzzy/brain/folders?path=knowledge/programming/snippets")).status, 404);
    eq((await call(alice, "GET", "/api/buzzy/brain/nope")).status, 404);
    eq((await call(alice, "PATCH", "/api/buzzy/brain/tidy")).status, 405);
  });
  await ok("an oversized body and bad JSON are refused plainly; nothing changes", async () => {
    const big = await call(alice, "POST", "/api/buzzy/brain/folders", undefined, JSON.stringify({ parent: "knowledge", name: "x".repeat(20000) }));
    eq([big.status, big.json.code], [413, "too_big"]);
    const bad = await call(alice, "POST", "/api/buzzy/brain/folders", undefined, "{nope");
    eq([bad.status, bad.json.code], [400, "bad_json"]);
  });

  console.log("\nClosing an account\n");

  await ok("every brain table is on the deletion list, and closing an account removes it all and no one else's", async () => {
    for (const t of ["buzzy_brain_places", "buzzy_brain_folders", "buzzy_brain_touches", "buzzy_brain_tidy", "buzzy_agent_starters"]) truthy(DELETION_STATEMENTS[t], `${t} is not removed`);
    await br.makeFolder(sql, "u1", "knowledge/home", "Keep");
    const bundle = await buildExportBundle(sql, "u1");
    const zip = await (await import("jszip")).default.loadAsync(bundle.bytes);
    truthy(Object.keys(zip.files).some((f) => /brain_your_folders\.csv$/.test(f)), "the folders they made leave with them");
    const before = await count("buzzy_brain_places", "u5");
    await deleteAccountData(sql, "u1");
    for (const t of ["buzzy_brain_places", "buzzy_brain_folders", "buzzy_brain_touches", "buzzy_brain_tidy", "buzzy_agent_starters", "buzzy_agents"]) eq(await count(t, "u1"), 0, t);
    eq(await count("buzzy_brain_places", "u5"), before, "u5 untouched");
  });

  console.log(`\nbrain: ${pass} checks passed${fail ? `, ${fail} FAILED` : ""}`);
  model.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
