/**
 * The brain: one tree for everything BeeZilla and the Zilla agents keep.
 *
 * Owner, 2026-11-23: "whenever somebody clicks a folder, they should also see a /brain at the
 * very core, which they can breadcrumb back to. When they breadcrumb back to it, it shows them
 * their memories. Their memories are stored in a structured folder tree that goes from A to Z…
 * The memory should be stored and organized into domains automatically, but you should be
 * easily able to find it." And: "When you click on a bot, you see the folders it often touches.
 * When you click on a folder, you see the entire folder tree… If you click any of the folders,
 * it will highlight many of the bots that work frequently in that folder. It'll also give you a
 * list of recent sessions related to that folder." And: "the memory is going to store and
 * reorganize everything the AI stores based on what it thinks is the fastest path on a regular
 * basis… set up a cadence that makes sense for that."
 *
 *   brain/
 *     knowledge/<subject>/…   remembered decisions and conversations, filed by subject (brainMap.ts)
 *     systems/bots/<bot>/     each agent's agent.md and its picture (BeeZilla's too)
 *     systems/skills/<use>/   BeeZilla's skills, by what they are useful for
 *     systems/recipes/        the person's own recipes from the Idea Board
 *     assets/<kind>/…         pictures, videos, music, 3D models and other files, to use again
 *
 * The tree is worked out from what is already kept (buzzy_user_memory, buzzy_sessions,
 * buzzy_assets, buzzy_agents, buzzy_board_recipes). This file keeps only what that cannot
 * know (migration 0068): where each movable thing sits (the tidy's choice, or the person's),
 * the folders the person made, which folders each turn was about, and when the last tidy ran.
 *
 * The tidy ("the fastest path"). Every memory, conversation and file goes in the folder for its
 * subject (assets: for its kind). A folder that grows past SPLIT_AT loose things is split by
 * topic (the job or conversation they came from) wherever a topic has GROUP_MIN things or more;
 * a split that shrinks back is undone. So no folder is a wall of hundreds, nothing is more than
 * a few clicks deep, and the tree reads A to Z at every level. Something new is placed the
 * moment it is first seen, in the folder the tree already has for it, and stays there until
 * the next tidy, so nothing moves while the person is looking. The tidy runs once a day, or
 * sooner once TIDY_AFTER_NEW new things are waiting, when the brain is next opened (the panel
 * or the Memory tab); "Tidy now" runs it at once. Whatever the person moved, or a folder they
 * made, the tidy never touches.
 *
 * Everything here is the person's own, scoped by user_id on every query; another account's
 * agent or folder is answered like one that does not exist.
 */
import type { Sql } from "@/lib/db";
import { BZILLA, agentImage, listAgents, type Agent } from "./agents";
import {
  ASSET_KINDS,
  BRANCHES,
  GENERAL,
  PURPOSES,
  ROOT,
  SKILLS,
  SUBJECTS,
  assetKindOf,
  branchOf,
  cleanPath,
  mapLabel,
  slug,
  subjectOf,
  within,
  words,
} from "./brainMap";

// ── The tidy's numbers ──────────────────────────────────────────────────────

/** A folder with more loose things than this is split by topic at the next tidy. */
export const SPLIT_AT = 12;
/** A topic needs at least this many things to get a folder of its own. */
export const GROUP_MIN = 3;
/** The tidy runs at most once a day… */
export const TIDY_EVERY_MS = 24 * 60 * 60 * 1000;
/** …or sooner, once this many new things are waiting for it. */
export const TIDY_AFTER_NEW = 20;
/** How many of the person's touches are kept (the newest). */
export const TOUCHES_KEEP = 5000;
/** How far back "often" looks when ranking folders and bots. */
const RECENT_DAYS = 90;
/** The most of each source read into one tree. */
const READ_MAX = 600;

// ── Shapes of the answer ────────────────────────────────────────────────────

export type ItemKind = "memory" | "conversation" | "file" | "agent-md" | "avatar" | "skill" | "recipe";

/** One thing in the tree. `id` says where it comes from, and is what a move names. */
export interface BrainItem {
  id: string;
  kind: ItemKind;
  /** The folder it sits in, without "brain/". */
  path: string;
  title: string;
  /** One line under the title. */
  sub: string;
  /** The text itself, when it is short enough to show (a memory's value, an agent.md). */
  body?: string;
  /** A picture or file to show or open. */
  url?: string;
  contentType?: string;
  sessionId?: string;
  agentId?: string;
  at: string;
  /** Whether the person can move it (memories, conversations, files and recipes). */
  movable: boolean;
  /** For a skill: the start of a request that uses it ("Search the web for "). */
  ask?: string;
  /** Who chose where it sits: the tidy, or the person. Only for movable things. */
  placedBy?: "auto" | "person";
}

/** One folder. Counts include everything below it. */
export interface BrainFolder {
  path: string;
  /** Its name in words ("Programming", "Code Monkey", "Kitchen remodel"). */
  label: string;
  branch: string;
  depth: number;
  /** Things directly in it. */
  own: number;
  /** Things in it and everything below it. */
  total: number;
  /** Who made it: the map (always there), the tidy, the person, or an agent's folders. */
  made: "map" | "tidy" | "person" | "agent";
}

export interface TidyState {
  at: string | null;
  items: number;
  moved: number;
  /** When the next one is due. */
  next: string | null;
  /** True when this answer ran one. */
  ran: boolean;
}

export interface Brain {
  root: typeof ROOT;
  branches: typeof BRANCHES;
  folders: BrainFolder[];
  items: BrainItem[];
  tidy: TidyState;
}

// ── Reading what is kept ────────────────────────────────────────────────────

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : v ? String(v) : new Date(0).toISOString());
const one = (s: unknown, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** "budget_range" → "Budget range". */
function keyWords(key: string): string {
  const s = String(key ?? "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Note";
}

/** A thing that can be moved, before it is placed: where the tidy would file it, and its topic. */
interface Loose {
  item: BrainItem;
  /** knowledge/<subject>, assets/<kind> or systems/recipes. */
  base: string;
  /** The job or conversation it came from, for splitting a big folder. "" when none. */
  topic: string;
  topicLabel: string;
}

async function safe<T>(read: () => Promise<T[]>): Promise<T[]> {
  try { return await read(); } catch { return []; }
}

/** The movable things: remembered decisions, conversations with a summary, files, recipes. */
async function readLoose(sql: Sql, userId: string): Promise<Loose[]> {
  const facts = await safe(() => sql<{ job_id: string | null; key: string; value: string; updated_at: Date | string; topic: string | null }>`
    SELECT m.job_id, m.key, m.value, m.updated_at, COALESCE(j.title, s.title) AS topic
    FROM buzzy_user_memory m
    LEFT JOIN buzzy_jobs j ON j.id = m.job_id AND j.user_id = m.user_id
    LEFT JOIN buzzy_sessions s ON s.id = m.job_id AND s.user_id = m.user_id
    WHERE m.user_id = ${userId} AND m.value <> ''
    ORDER BY m.updated_at DESC
    LIMIT ${READ_MAX}
  `);
  const chats = await safe(() => sql<{ id: string; title: string; summary: string | null; agent_id: string | null; job_title: string | null; updated_at: Date | string }>`
    SELECT s.id, s.title, s.summary, s.agent_id, j.title AS job_title, s.updated_at
    FROM buzzy_sessions s
    LEFT JOIN buzzy_jobs j ON j.id = s.job_id AND j.user_id = s.user_id
    WHERE s.user_id = ${userId} AND s.summary IS NOT NULL AND s.summary <> ''
    ORDER BY s.updated_at DESC
    LIMIT ${READ_MAX}
  `);
  const files = await safe(() => sql<{ id: number | string; filename: string; rel_path: string; content_type: string | null; bytes: number; created_at: Date | string; session_id: string | null; topic: string | null }>`
    SELECT a.id, a.filename, a.rel_path, a.content_type, a.bytes, a.created_at, a.session_id,
           COALESCE(j.title, s.title) AS topic
    FROM buzzy_assets a
    LEFT JOIN buzzy_jobs j ON j.id = a.job_id AND j.user_id = a.user_id
    LEFT JOIN buzzy_sessions s ON s.id = a.session_id AND s.user_id = a.user_id
    WHERE a.user_id = ${userId}
    ORDER BY a.created_at DESC
    LIMIT ${READ_MAX}
  `);
  const recipes = await safe(() => sql<{ id: string; name: string; graph: unknown; created_at: Date | string }>`
    SELECT id, name, graph, created_at FROM buzzy_board_recipes
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT 200
  `);

  const out: Loose[] = [];
  for (const f of facts) {
    const topic = one(f.topic, 80);
    const label = keyWords(f.key);
    // Filed by the job it belongs to first: a kitchen remodel's budget is about the home.
    let subject = subjectOf(topic);
    if (subject === GENERAL.id) subject = subjectOf(`${label} ${f.value}`);
    out.push({
      item: {
        id: `fact:${f.job_id ?? ""}:${f.key}`,
        kind: "memory",
        path: "",
        title: label,
        sub: topic ? `From ${topic}` : "Something you told BeeZilla",
        body: one(f.value, 600),
        at: iso(f.updated_at),
        movable: true,
      },
      base: `knowledge/${subject}`,
      topic: topic ? slug(topic) : "",
      topicLabel: topic,
    });
  }
  for (const c of chats) {
    const title = one(c.title, 120) || "Conversation";
    const summary = one(c.summary, 400);
    let subject = subjectOf(c.job_title ?? "");
    if (subject === GENERAL.id) subject = subjectOf(title);
    if (subject === GENERAL.id) subject = subjectOf(summary);
    out.push({
      item: {
        id: `chat:${c.id}`,
        kind: "conversation",
        path: "",
        title,
        sub: summary,
        sessionId: c.id,
        agentId: c.agent_id ?? BZILLA.id,
        at: iso(c.updated_at),
        movable: true,
      },
      base: `knowledge/${subject}`,
      topic: c.job_title ? slug(c.job_title) : "",
      topicLabel: one(c.job_title, 80),
    });
  }
  for (const a of files) {
    const kind = assetKindOf(a.content_type, a.filename);
    const topic = one(a.topic, 80);
    const kb = Math.max(1, Math.round(Number(a.bytes || 0) / 1024));
    out.push({
      item: {
        id: `file:${a.id}`,
        kind: "file",
        path: "",
        title: one(a.filename, 120) || "File",
        sub: (topic ? `From ${topic} · ` : "") + (kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`),
        url: `/api/buzzy/assets/${a.id}`,
        contentType: one(a.content_type, 120),
        sessionId: a.session_id ?? undefined,
        at: iso(a.created_at),
        movable: true,
      },
      base: `assets/${kind}`,
      topic: topic ? slug(topic) : "",
      topicLabel: topic,
    });
  }
  for (const r of recipes) {
    let steps = 0;
    try {
      const g = typeof r.graph === "string" ? JSON.parse(r.graph) : r.graph;
      steps = Array.isArray((g as { nodes?: unknown[] })?.nodes) ? (g as { nodes: Array<{ kind?: string }> }).nodes.filter((n) => n?.kind === "skill").length : 0;
    } catch { steps = 0; }
    out.push({
      item: {
        id: `recipe:${r.id}`,
        kind: "recipe",
        path: "",
        title: one(r.name, 120) || "Recipe",
        sub: `${steps} step${steps === 1 ? "" : "s"} · made on your Idea Board`,
        at: iso(r.created_at),
        movable: true,
      },
      base: "systems/recipes",
      topic: "",
      topicLabel: "",
    });
  }
  return out;
}

/** A bot's folder name: its name as a path part, made unique with its id when two share one. */
export function botFolders(agents: Array<Pick<Agent, "id" | "name">>): Map<string, string> {
  const out = new Map<string, string>([[BZILLA.id, "systems/bots/beezilla"]]);
  const taken = new Set<string>(["beezilla"]);
  for (const a of agents) {
    let s = slug(a.name, "agent");
    if (taken.has(s)) s = `${s}-${a.id.slice(-4)}`;
    taken.add(s);
    out.set(a.id, `systems/bots/${s}`);
  }
  return out;
}

/** An agent's agent.md, written out: who it is, its job, where it works, in plain words. */
export function agentMd(a: { name: string; role: string; instructions?: string; domains?: string[]; color?: string; creature?: string; look?: string }, isBz = false): string {
  const lines = [`# ${a.name}`, ""];
  if (isBz) {
    lines.push("Your executive assistant. Works across everything and looks after all your agents: she can ask them, they can ask her, and she can make new ones.");
  } else {
    lines.push(a.role ? `Helps with: ${a.role}` : "Helps with: nothing yet. Open it and tell it what to take care of.");
    if (a.instructions) lines.push("", `In your words: "${a.instructions}"`);
  }
  const where = isBz ? ["the whole brain"] : (a.domains ?? []).map((d) => "brain/" + d);
  lines.push("", `Works in: ${where.length ? where.join(", ") : "no folders yet"}`);
  if (!isBz) lines.push("", `Looks like: ${a.look ? a.look + " " : ""}${a.creature ?? "zilla"}, colour ${a.color ?? ""}`.trim());
  lines.push("", "Skills: any of them. Skills belong to no bot; they live in brain/systems/skills, by what they are useful for.");
  return lines.join("\n");
}

/** The fixed things: each bot's agent.md and picture, the skills by purpose. */
function fixedItems(agents: Agent[], bots: Map<string, string>): BrainItem[] {
  const out: BrainItem[] = [];
  const everyone: Array<{ a: Agent | null; id: string }> = [{ a: null, id: BZILLA.id }, ...agents.map((a) => ({ a, id: a.id }))];
  for (const { a, id } of everyone) {
    const folder = bots.get(id)!;
    const name = a ? a.name : BZILLA.name;
    const at = a ? a.updatedAt : new Date(0).toISOString();
    out.push({
      id: `bot:${id}:agent.md`,
      kind: "agent-md",
      path: folder,
      title: "agent.md",
      sub: a ? (a.role ? `${name} helps with ${a.role}` : `${name} is waiting for a job`) : `${name}, your executive assistant`,
      body: agentMd(a ?? { name: BZILLA.name, role: BZILLA.role }, !a),
      agentId: id,
      at,
      movable: false,
    });
    out.push({
      id: `bot:${id}:avatar`,
      kind: "avatar",
      path: folder,
      title: "avatar",
      sub: a ? "Its picture. Change it from its Edit window (the ⋯ beside it)." : "BeeZilla's own face",
      url: a ? agentImage(a.creature, a.look) : BZILLA.image,
      contentType: "image/webp",
      agentId: id,
      at,
      movable: false,
    });
  }
  for (const s of SKILLS) {
    for (const use of s.uses) {
      const also = s.uses.filter((u) => u !== use).map((u) => PURPOSES.find((p) => p.id === u)?.label ?? words(u));
      out.push({
        id: `skill:${s.id}@${use}`,
        kind: "skill",
        path: `systems/skills/${use}`,
        title: s.name,
        sub: s.blurb + (also.length ? ` Also useful for ${also.join(", ").toLowerCase()}.` : ""),
        ask: s.ask,
        at: new Date(0).toISOString(),
        movable: false,
      });
    }
  }
  return out;
}

// ── Placing and tidying ─────────────────────────────────────────────────────

interface PlaceRow {
  item: string;
  path: string;
  placed_by: string;
}

/**
 * Where the tidy files each of these things: its base folder, or base/<topic> when the base
 * holds more than SPLIT_AT and the topic has GROUP_MIN or more. Pure, so it can be tested:
 * the same things always go to the same places.
 */
export function planTidy(loose: Array<Pick<Loose, "base" | "topic"> & { id: string }>): Map<string, string> {
  const byBase = new Map<string, Array<{ id: string; topic: string }>>();
  for (const l of loose) {
    const list = byBase.get(l.base) ?? [];
    list.push({ id: l.id, topic: l.topic });
    byBase.set(l.base, list);
  }
  const out = new Map<string, string>();
  for (const [base, list] of byBase) {
    const split = list.length > SPLIT_AT;
    const count = new Map<string, number>();
    if (split) for (const x of list) if (x.topic) count.set(x.topic, (count.get(x.topic) ?? 0) + 1);
    for (const x of list) {
      const sub = split && x.topic && (count.get(x.topic) ?? 0) >= GROUP_MIN ? cleanPath(`${base}/${x.topic}`) : null;
      out.set(x.id, sub ?? base);
    }
  }
  return out;
}

/** Where something new goes between tidies: its topic's folder if the tree already has one, else its base. */
function arrival(l: Loose, folders: Set<string>): string {
  const sub = l.topic ? cleanPath(`${l.base}/${l.topic}`) : null;
  return sub && folders.has(sub) ? sub : l.base;
}

/** Is a move into this folder allowed for this kind of thing? Knowledge stays knowledge, files stay assets. */
export function fitsBranch(kind: ItemKind, path: string): boolean {
  if (kind === "memory" || kind === "conversation") return within(path, "knowledge");
  if (kind === "file") return within(path, "assets");
  if (kind === "recipe") return within(path, "systems/recipes");
  return false;
}

async function writePlaces(sql: Sql, userId: string, rows: Array<{ item: string; path: string }>, by: "auto" | "person"): Promise<void> {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    await sql.query(
      `INSERT INTO buzzy_brain_places (user_id, item, path, placed_by, placed_at)
       SELECT $1::text, r.item, r.path, $3::text, now()
         FROM jsonb_to_recordset($2::jsonb) AS r(item text, path text)
       ON CONFLICT (user_id, item) DO UPDATE
         SET path = EXCLUDED.path, placed_by = EXCLUDED.placed_by, placed_at = now()
         WHERE buzzy_brain_places.placed_by = 'auto' OR EXCLUDED.placed_by = 'person'`,
      [userId, JSON.stringify(chunk), by],
    );
  }
}

/** Options for building the tree. */
export interface BuildOptions {
  /** "auto": tidy if it is due (the default). "now": tidy whatever the time. "never": don't. */
  tidy?: "auto" | "now" | "never";
  /** The clock, for tests. */
  now?: Date;
}

/**
 * The whole brain of one person: every folder (A to Z within each folder), every thing in
 * it, and when it was last tidied. Places new things, and tidies when it is due.
 */
export async function buildBrain(sql: Sql, userId: string, opts: BuildOptions = {}): Promise<Brain> {
  return (await buildAll(sql, userId, opts)).brain;
}

/** The brain, with the agents and their bot folders it was built from (the panel needs both). */
async function buildAll(sql: Sql, userId: string, opts: BuildOptions = {}): Promise<{ brain: Brain; agents: Agent[]; bots: Map<string, string> }> {
  const now = opts.now ?? new Date();
  const { agents } = await listAgents(sql, userId);
  const bots = botFolders(agents);
  const loose = await readLoose(sql, userId);
  const places = await safe(() => sql<PlaceRow>`SELECT item, path, placed_by FROM buzzy_brain_places WHERE user_id = ${userId}`);
  const personFolders = (await safe(() => sql<{ path: string }>`SELECT path FROM buzzy_brain_folders WHERE user_id = ${userId}`))
    .map((r) => cleanPath(r.path))
    .filter((p): p is string => !!p);
  const tidyRow = (await safe(() => sql<{ tidied_at: Date | string; items: number; moved: number }>`
    SELECT tidied_at, items, moved FROM buzzy_brain_tidy WHERE user_id = ${userId}
  `))[0];
  // Folders turns were about: a subject an agent talked about is a folder even before anything is filed in it.
  const touched = (await safe(() => sql<{ path: string }>`SELECT DISTINCT path FROM buzzy_brain_touches WHERE user_id = ${userId}`))
    .map((r) => cleanPath(r.path))
    .filter((p): p is string => !!p);

  const placed = new Map(places.map((p) => [p.item, p] as const));
  const known = new Set<string>(personFolders);
  for (const p of places) {
    const c = cleanPath(p.path);
    if (c) for (let parts = c.split("/"), i = 1; i <= parts.length; i++) known.add(parts.slice(0, i).join("/"));
  }

  // Due? Once a day, or once enough new things are waiting; "now" always; "never" never.
  const fresh = loose.filter((l) => !placed.has(l.item.id));
  const last = tidyRow ? new Date(iso(tidyRow.tidied_at)) : null;
  const due =
    opts.tidy === "now" ||
    (opts.tidy !== "never" && loose.length > 0 && (!last || now.getTime() - last.getTime() >= TIDY_EVERY_MS || fresh.length >= TIDY_AFTER_NEW));

  let moved = 0;
  let ran = false;
  if (due) {
    const auto = loose.filter((l) => placed.get(l.item.id)?.placed_by !== "person");
    const plan = planTidy(auto.map((l) => ({ id: l.item.id, base: l.base, topic: l.topic })));
    const writes: Array<{ item: string; path: string }> = [];
    for (const l of auto) {
      const to = plan.get(l.item.id)!;
      const was = placed.get(l.item.id)?.path;
      if (was !== to) {
        writes.push({ item: l.item.id, path: to });
        if (was !== undefined) moved++;
      }
      placed.set(l.item.id, { item: l.item.id, path: to, placed_by: "auto" });
    }
    await writePlaces(sql, userId, writes, "auto");
    // Places of things that are no longer kept (a forgotten memory, a deleted file) go too.
    const alive = new Set(loose.map((l) => l.item.id));
    const gone = places.filter((p) => !alive.has(p.item)).map((p) => p.item);
    if (gone.length) {
      try {
        await sql.query(
          `DELETE FROM buzzy_brain_places WHERE user_id = $1 AND item IN (SELECT jsonb_array_elements_text($2::jsonb))`,
          [userId, JSON.stringify(gone)],
        );
      } catch { /* kept for the next tidy */ }
    }
    try {
      await sql`
        INSERT INTO buzzy_brain_tidy (user_id, tidied_at, items, moved)
        VALUES (${userId}, ${now.toISOString()}::timestamptz, ${loose.length}, ${moved})
        ON CONFLICT (user_id) DO UPDATE SET tidied_at = EXCLUDED.tidied_at, items = EXCLUDED.items, moved = EXCLUDED.moved
      `;
    } catch { /* the tidy still happened; it will just run again */ }
    ran = true;
  } else {
    // Not due: new things are placed where the tree already has a place for them.
    const folderSet = new Set<string>(known);
    const writes: Array<{ item: string; path: string }> = [];
    for (const l of fresh) {
      const to = arrival(l, folderSet);
      writes.push({ item: l.item.id, path: to });
      placed.set(l.item.id, { item: l.item.id, path: to, placed_by: "auto" });
    }
    await writePlaces(sql, userId, writes, "auto").catch(() => undefined);
  }

  const items: BrainItem[] = [];
  for (const l of loose) {
    const p = placed.get(l.item.id);
    const path = (p && cleanPath(p.path)) || l.base;
    items.push({ ...l.item, path, placedBy: p?.placed_by === "person" ? "person" : "auto" });
  }
  items.push(...fixedItems(agents, bots));

  // Folder names in words: the map's own, a bot's name, a topic's title, or the path part.
  const labels = new Map<string, string>();
  for (const [id, path] of bots) labels.set(path, id === BZILLA.id ? BZILLA.name : agents.find((a) => a.id === id)?.name ?? words(path.split("/").pop()!));
  for (const l of loose) {
    const p = placed.get(l.item.id)?.path;
    if (p && l.topic && p.endsWith("/" + l.topic) && l.topicLabel) labels.set(p, l.topicLabel);
  }

  // Every folder: the map's (always there), every agent's folders, the person's, and every
  // folder something sits in (with all the folders above it).
  const made = new Map<string, BrainFolder["made"]>();
  const add = (path: string, how: BrainFolder["made"]) => {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      if (!made.has(p)) made.set(p, i === parts.length ? how : "map");
    }
  };
  for (const b of BRANCHES) add(b.id, "map");
  add("systems/bots", "map");
  add("systems/recipes", "map");
  for (const p of PURPOSES) add(`systems/skills/${p.id}`, "map");
  for (const k of ASSET_KINDS) add(`assets/${k.id}`, "map");
  for (const path of bots.values()) add(path, "map");
  for (const a of agents) for (const d of a.domains) add(d, "agent");
  for (const p of personFolders) add(p, "person");
  for (const p of touched) add(p, "tidy");
  for (const it of items) add(it.path, "tidy");

  const own = new Map<string, number>();
  for (const it of items) own.set(it.path, (own.get(it.path) ?? 0) + 1);
  const folders: BrainFolder[] = [...made.entries()].map(([path, how]) => {
    let total = 0;
    for (const [p, n] of own) if (within(p, path)) total += n;
    return {
      path,
      label: labels.get(path) ?? mapLabel(path) ?? words(path.split("/").pop()!),
      branch: path.split("/")[0]!,
      depth: path.split("/").length,
      own: own.get(path) ?? 0,
      total,
      made: how,
    };
  });
  // A to Z at every level: by path, each part compared in words.
  folders.sort((a, b) => sortKey(a, folders).localeCompare(sortKey(b, folders)));

  const next = last || ran ? new Date((ran ? now : last!).getTime() + TIDY_EVERY_MS).toISOString() : null;
  const brain: Brain = {
    root: ROOT,
    branches: BRANCHES,
    folders,
    items,
    tidy: {
      at: ran ? now.toISOString() : last ? last.toISOString() : null,
      items: ran ? loose.length : Number(tidyRow?.items ?? 0),
      moved: ran ? moved : Number(tidyRow?.moved ?? 0),
      next,
      ran,
    },
  };
  return { brain, agents, bots };
}

/** The A-to-Z key of a folder: its ancestors' labels, then its own, lower case. The branches keep the map's order. */
function sortKey(f: BrainFolder, all: BrainFolder[]): string {
  const parts = f.path.split("/");
  const keys: string[] = [];
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join("/");
    if (i === 1) { keys.push(String(BRANCHES.findIndex((b) => b.id === p))); continue; }
    const label = all.find((x) => x.path === p)?.label ?? parts[i - 1]!;
    keys.push(label.toLowerCase());
  }
  return keys.join("\u0001");
}

// ── Touches: which folder each turn was about ───────────────────────────────

/**
 * Remember which folder a turn was about, and who was speaking: the subject of what the person
 * said (knowledge/<subject>). A message about nothing in particular ("hi") leaves nothing.
 * Only the newest TOUCHES_KEEP of a person are kept. Never throws: a touch that cannot be
 * written is dropped and the turn goes on.
 */
export async function noteTurn(
  sql: Sql,
  userId: string,
  turn: { agentId?: string | null; sessionId?: string | null; message: string },
): Promise<string | null> {
  try {
    const subject = subjectOf(turn.message);
    if (subject === GENERAL.id) return null;
    const path = `knowledge/${subject}`;
    const who = turn.agentId && /^ag_[a-z0-9]{12}$/.test(turn.agentId) ? turn.agentId : BZILLA.id;
    const sid = turn.sessionId && /^[A-Za-z0-9_-]{1,80}$/.test(turn.sessionId) ? turn.sessionId : null;
    await sql`INSERT INTO buzzy_brain_touches (user_id, path, agent_id, session_id) VALUES (${userId}, ${path}, ${who}, ${sid})`;
    await sql`
      DELETE FROM buzzy_brain_touches
      WHERE user_id = ${userId}
        AND id <= (SELECT id FROM buzzy_brain_touches WHERE user_id = ${userId} ORDER BY id DESC OFFSET ${TOUCHES_KEEP} LIMIT 1)
    `;
    return path;
  } catch (err) {
    console.warn("[buzzy/brain] a touch was dropped:", err instanceof Error ? err.message : err);
    return null;
  }
}

interface TouchRow {
  path: string;
  agent_id: string;
  session_id: string | null;
  at: Date | string;
}

async function readTouches(sql: Sql, userId: string, now: Date): Promise<TouchRow[]> {
  const since = new Date(now.getTime() - RECENT_DAYS * 86400000).toISOString();
  return safe(() => sql<TouchRow>`
    SELECT path, agent_id, session_id, at FROM buzzy_brain_touches
    WHERE user_id = ${userId} AND at >= ${since}::timestamptz
    ORDER BY id DESC
    LIMIT ${TOUCHES_KEEP}
  `);
}

// ── How much an agent works in a folder ─────────────────────────────────────

/** The folders an agent works in, with BeeZilla working in her own bot folder and across all she touched. */
function homeOf(agentId: string, agents: Agent[], bots: Map<string, string>): string[] {
  const own = bots.get(agentId);
  const a = agents.find((x) => x.id === agentId);
  return [...(a ? a.domains : []), ...(own ? [own] : [])];
}

/**
 * How much `agentId` works in `folder`: its own folders (a folder of its, or one inside or
 * above one of its) count most; then the turns it had there and the conversations of its that
 * are filed there. 0 means it does not work there.
 */
function scoreFor(
  agentId: string,
  folder: string,
  ctx: { agents: Agent[]; bots: Map<string, string>; touches: TouchRow[]; items: BrainItem[] },
): number {
  let score = 0;
  for (const d of homeOf(agentId, ctx.agents, ctx.bots)) {
    if (d === folder) score += 60;
    else if (within(d, folder) || within(folder, d)) score += 25;
  }
  let turns = 0;
  for (const t of ctx.touches) if (t.agent_id === agentId && within(t.path, folder)) turns++;
  let chats = 0;
  for (const it of ctx.items) if (it.kind === "conversation" && it.agentId === agentId && within(it.path, folder)) chats++;
  return score + Math.min(turns, 40) * 2 + Math.min(chats, 20) * 3;
}

/** One folder as an agent's panel lists it. */
export interface PanelFolder {
  path: string;
  label: string;
  branch: string;
  /** The labels from the branch down to it ("knowledge", "Programming"). */
  crumbs: string[];
  total: number;
  /** On top and lit: a folder this agent often works in. */
  hot: boolean;
  score: number;
}

/** One conversation in a History list. */
export interface SessionLine {
  id: string;
  title: string;
  summary: string;
  agentId: string;
  updatedAt: string;
}

function crumbsOf(path: string, folders: BrainFolder[]): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join("/");
    out.push(folders.find((f) => f.path === p)?.label ?? words(parts[i - 1]!));
  }
  return out;
}

/** The folders a panel lists: everything two levels down, the bots' and skills' own, and any deeper one that is hot. */
function listable(f: BrainFolder): boolean {
  if (f.depth === 2) return f.path !== "systems/bots" && f.path !== "systems/skills";
  return f.depth === 3 && (f.path.startsWith("systems/skills/") || f.path.startsWith("systems/bots/"));
}

async function sessionsWhere(sql: Sql, userId: string, ids: string[]): Promise<SessionLine[]> {
  if (!ids.length) return [];
  const rows = await safe(() => sql.query<{ id: string; title: string; summary: string | null; agent_id: string | null; updated_at: Date | string }>(
    `SELECT id, title, summary, agent_id, updated_at FROM buzzy_sessions
      WHERE user_id = $1 AND id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [userId, JSON.stringify(ids.slice(0, 200))],
  ));
  return rows.map(toLine);
}

const toLine = (r: { id: string; title: string; summary: string | null; agent_id: string | null; updated_at: Date | string }): SessionLine => ({
  id: r.id,
  title: one(r.title, 120) || "Conversation",
  summary: one(r.summary, 220),
  agentId: r.agent_id ?? BZILLA.id,
  updatedAt: iso(r.updated_at),
});

/**
 * An agent's panel: the folders it often works in (lit, on top, most first) and the rest of
 * the brain's folders (grey, A to Z), and its recent conversations (History). null when the
 * agent is not the person's.
 */
export async function agentPanel(
  sql: Sql,
  userId: string,
  agentId: string,
  opts: BuildOptions = {},
): Promise<{ agent: { id: string; name: string; color: string; folder: string }; folders: PanelFolder[]; history: SessionLine[] } | null> {
  const now = opts.now ?? new Date();
  const { brain, agents, bots } = await buildAll(sql, userId, opts);
  const isBz = agentId === BZILLA.id;
  const agent = isBz ? null : agents.find((a) => a.id === agentId);
  if (!isBz && !agent) return null;
  const touches = await readTouches(sql, userId, now);
  const ctx = { agents, bots, touches, items: brain.items };
  const folders: PanelFolder[] = brain.folders
    .filter((f) => listable(f) || (f.depth >= 3 && scoreFor(agentId, f.path, ctx) > 0 && f.made !== "map"))
    .map((f) => {
      const score = scoreFor(agentId, f.path, ctx);
      return { path: f.path, label: f.label, branch: f.branch, crumbs: crumbsOf(f.path, brain.folders), total: f.total, hot: score > 0, score };
    });
  // Lit first, the most worked-in on top; then the rest in the tree's own A-to-Z order.
  const hot = folders.filter((f) => f.hot).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const grey = folders.filter((f) => !f.hot);
  const history = (await safe(() => isBz
    ? sql<{ id: string; title: string; summary: string | null; agent_id: string | null; updated_at: Date | string }>`
        SELECT id, title, summary, agent_id, updated_at FROM buzzy_sessions
        WHERE user_id = ${userId} AND agent_id IS NULL
        ORDER BY updated_at DESC LIMIT 12`
    : sql<{ id: string; title: string; summary: string | null; agent_id: string | null; updated_at: Date | string }>`
        SELECT id, title, summary, agent_id, updated_at FROM buzzy_sessions
        WHERE user_id = ${userId} AND agent_id = ${agentId}
        ORDER BY updated_at DESC LIMIT 12`)).map(toLine);
  return {
    agent: { id: isBz ? BZILLA.id : agent!.id, name: isBz ? BZILLA.name : agent!.name, color: isBz ? BZILLA.color : agent!.color, folder: bots.get(agentId) ?? "" },
    folders: [...hot, ...grey],
    history,
  };
}

/** One bot that works in a folder, for the panel and the Memory tab. */
export interface Worker {
  id: string;
  name: string;
  color: string;
  image: string;
  role: string;
  score: number;
}

/**
 * A folder, as the panel and the Memory tab show it: the bots that work in it most (BeeZilla
 * too), and the recent conversations about it (turns about it, and conversations filed in it).
 * null when the folder is not in the person's tree.
 */
export async function folderInfo(
  sql: Sql,
  userId: string,
  rawPath: unknown,
  opts: BuildOptions = {},
): Promise<{ folder: BrainFolder; crumbs: string[]; workers: Worker[]; sessions: SessionLine[] } | null> {
  const path = cleanPath(rawPath);
  if (!path) return null;
  const now = opts.now ?? new Date();
  const { brain, agents, bots } = await buildAll(sql, userId, opts);
  const folder = brain.folders.find((f) => f.path === path);
  if (!folder) return null;
  const touches = await readTouches(sql, userId, now);
  const ctx = { agents, bots, touches, items: brain.items };
  const everyone = [
    { id: BZILLA.id, name: BZILLA.name, color: BZILLA.color, image: BZILLA.image, role: BZILLA.role },
    ...agents.map((a) => ({ id: a.id, name: a.name, color: a.color, image: a.image, role: a.role })),
  ];
  const workers = everyone
    .map((w) => ({ ...w, score: scoreFor(w.id, path, ctx) }))
    .filter((w) => w.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 12);
  // Recent conversations: the newest turn about this folder first, then conversations filed here.
  const order: string[] = [];
  for (const t of touches) if (t.session_id && within(t.path, path) && !order.includes(t.session_id)) order.push(t.session_id);
  for (const it of brain.items) if (it.kind === "conversation" && it.sessionId && within(it.path, path) && !order.includes(it.sessionId)) order.push(it.sessionId);
  const lines = await sessionsWhere(sql, userId, order);
  const sessions = lines.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)).slice(0, 12);
  return { folder, crumbs: crumbsOf(path, brain.folders), workers, sessions };
}

// ── What the person changes ─────────────────────────────────────────────────

export type Refusal = { ok: false; status: number; code: string; error: string };
const no = (status: number, code: string, error: string): Refusal => ({ ok: false, status, code, error });

/** Folders the person may make: anywhere in knowledge and assets, and in their recipes. */
function mayMakeIn(path: string): boolean {
  return within(path, "knowledge") || within(path, "assets") || within(path, "systems/recipes");
}

/** Make a folder ("New folder" in the Memory tab). Its name is cleaned into a path part. */
export async function makeFolder(sql: Sql, userId: string, parent: unknown, name: unknown): Promise<{ ok: true; path: string } | Refusal> {
  const base = cleanPath(parent);
  if (!base) return no(400, "bad_path", "Say where the new folder goes, like knowledge/home.");
  const part = slug(name, "");
  if (!part) return no(400, "bad_name", "Give the folder a name: letters or numbers.");
  const path = cleanPath(`${base}/${part}`);
  if (!path) return no(400, "too_deep", "That is deeper than the brain goes. Put it one level up.");
  if (!mayMakeIn(path) || path.split("/").length < 2) {
    return no(400, "fixed_folder", "Bots and skills are kept by BeeZilla. Make folders in knowledge, assets or your recipes.");
  }
  await sql`INSERT INTO buzzy_brain_folders (user_id, path) VALUES (${userId}, ${path}) ON CONFLICT (user_id, path) DO NOTHING`;
  return { ok: true, path };
}

/** Remove a folder the person made, when nothing is in it. */
export async function removeFolder(sql: Sql, userId: string, rawPath: unknown): Promise<{ ok: true } | Refusal> {
  const path = cleanPath(rawPath);
  if (!path) return no(400, "bad_path", "That isn't a folder in the brain.");
  const mine = await sql<{ path: string }>`SELECT path FROM buzzy_brain_folders WHERE user_id = ${userId} AND path = ${path}`;
  if (!mine.length) return no(404, "not_found", "Only folders you made can be removed; BeeZilla's own come and go with what is in them.");
  const brain = await buildBrain(sql, userId, { tidy: "never" });
  const inside = brain.items.filter((it) => within(it.path, path)).length;
  const below = brain.folders.filter((f) => f.path !== path && within(f.path, path) && f.made === "person").length;
  if (inside || below) return no(409, "not_empty", "Move what is in it somewhere else first.");
  await sql`DELETE FROM buzzy_brain_folders WHERE user_id = ${userId} AND path = ${path}`;
  return { ok: true };
}

/**
 * Move one thing to a folder: from then on the tidy leaves it there. `path` null hands it back
 * to the tidy, which files it again at its next run (and places it at once in its base folder).
 */
export async function placeItem(sql: Sql, userId: string, item: unknown, rawPath: unknown): Promise<{ ok: true; path: string } | Refusal> {
  if (typeof item !== "string" || !/^(fact|chat|file|recipe):/.test(item) || item.length > 300) {
    return no(400, "bad_item", "Only memories, conversations, files and recipes can be moved.");
  }
  const brain = await buildBrain(sql, userId, { tidy: "never" });
  const it = brain.items.find((x) => x.id === item);
  if (!it || !it.movable) return no(404, "not_found", "There is nothing like that in your brain.");
  if (rawPath === null) {
    await sql`DELETE FROM buzzy_brain_places WHERE user_id = ${userId} AND item = ${item}`;
    const back = await buildBrain(sql, userId, { tidy: "never" });
    return { ok: true, path: back.items.find((x) => x.id === item)?.path ?? it.path };
  }
  const path = cleanPath(rawPath);
  if (!path) return no(400, "bad_path", "That isn't a folder in the brain.");
  if (!fitsBranch(it.kind, path)) {
    const where = it.kind === "file" ? "assets" : it.kind === "recipe" ? "systems/recipes" : "knowledge";
    return no(400, "wrong_branch", `That belongs in ${where}, so it can only move to a folder there.`);
  }
  if (!brain.folders.some((f) => f.path === path)) return no(404, "no_folder", "There is no folder there yet. Make it first.");
  await writePlaces(sql, userId, [{ item, path }], "person");
  return { ok: true, path };
}

// ── The route ───────────────────────────────────────────────────────────────

export interface BrainReply {
  status: number;
  body: Record<string, unknown>;
}
const reply = (status: number, body: Record<string, unknown>): BrainReply => ({ status, body });
const refuse = (r: Refusal): BrainReply => reply(r.status, { ok: false, error: r.error, code: r.code });

/**
 * /api/buzzy/brain… for a signed-in person (chat.nitro.ts checks the session and reads the
 * body; `rest` is the path after /api/buzzy/brain).
 *
 *   GET    /                    { root, branches, folders, items, tidy } (tidies when due)
 *   GET    /folder?path=        { folder, crumbs, workers, sessions }: who works there, recent conversations
 *   GET    /agent/<id>          { agent, folders, history }: its folders (lit on top, grey below) and History
 *   POST   /tidy                tidy now → { tidy }
 *   POST   /folders             make one: { parent, name } → 201 { path }
 *   DELETE /folders?path=       remove one you made, when it is empty
 *   PUT    /place               move a thing: { item, path } (path null: back to the tidy) → { path }
 */
export async function brainRoute(
  sql: Sql,
  userId: string,
  method: string,
  rest: string,
  body: unknown,
  query: { path?: string | null } = {},
): Promise<BrainReply> {
  const parts = String(rest ?? "").split("/").filter(Boolean);
  const obj = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;

  if (parts.length === 0) {
    if (method !== "GET") return reply(405, { ok: false, error: "Use GET.", code: "method_not_allowed" });
    const brain = await buildBrain(sql, userId);
    return reply(200, { ok: true, ...brain });
  }
  if (parts[0] === "folder" && parts.length === 1) {
    if (method !== "GET") return reply(405, { ok: false, error: "Use GET.", code: "method_not_allowed" });
    const info = await folderInfo(sql, userId, query.path ?? "");
    if (!info) return reply(404, { ok: false, error: "There is no folder like that in your brain.", code: "not_found" });
    return reply(200, { ok: true, ...info });
  }
  if (parts[0] === "agent" && parts.length === 2) {
    if (method !== "GET") return reply(405, { ok: false, error: "Use GET.", code: "method_not_allowed" });
    const panel = await agentPanel(sql, userId, parts[1]!);
    if (!panel) return reply(404, { ok: false, error: "There is no agent like that on your account.", code: "not_found" });
    return reply(200, { ok: true, ...panel });
  }
  if (parts[0] === "tidy" && parts.length === 1) {
    if (method !== "POST") return reply(405, { ok: false, error: "Use POST.", code: "method_not_allowed" });
    const brain = await buildBrain(sql, userId, { tidy: "now" });
    return reply(200, { ok: true, tidy: brain.tidy });
  }
  if (parts[0] === "folders" && parts.length === 1) {
    if (method === "POST") {
      const made = await makeFolder(sql, userId, obj.parent, obj.name);
      return made.ok ? reply(201, { ok: true, path: made.path }) : refuse(made);
    }
    if (method === "DELETE") {
      const gone = await removeFolder(sql, userId, query.path ?? obj.path);
      return gone.ok ? reply(200, { ok: true }) : refuse(gone);
    }
    return reply(405, { ok: false, error: "Use POST or DELETE.", code: "method_not_allowed" });
  }
  if (parts[0] === "place" && parts.length === 1) {
    if (method !== "PUT") return reply(405, { ok: false, error: "Use PUT.", code: "method_not_allowed" });
    const out = await placeItem(sql, userId, obj.item, obj.path === null ? null : obj.path);
    return out.ok ? reply(200, { ok: true, path: out.path }) : refuse(out);
  }
  return reply(404, { ok: false, error: "There is no such brain page.", code: "not_found" });
}

/** For tests and the panel: the subjects there are, in the order they are tried. */
export const SUBJECT_IDS = SUBJECTS.map((s) => s.id);
export { branchOf };
