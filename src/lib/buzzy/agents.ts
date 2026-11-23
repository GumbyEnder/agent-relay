/**
 * Zilla agents: dedicated helpers in the left sidebar, each with a name, a size, a
 * colour and a job.
 *
 * Owner, 2026-11-21: "On the left side, we need to create an agent system … a series
 * of agents that can do things on your behalf. Each agent should have a name by
 * default given to them and a size and color." People start with the bee (BeeZilla
 * herself, the executive assistant) and one greyed-out bunny underneath; a plus adds
 * more, "maybe hundreds". Clicking an agent that has no job yet asks "what role do
 * you want me to play?"; from then on it "helps with" that job, and its face is an
 * emoji for the job ("if I say, you're in charge of my to-do list, it'll find a
 * to-do-list emoji and make that the face").
 *
 * What lives here:
 *   - the roster: the creatures and colours a Zilla comes in, where their pictures
 *     are (public/buzzy/zillas), and what the + button adds next (nextDefault);
 *   - cleaning and validation for every field a person can set;
 *   - turning the person's own words into a job (roleFromText) and a face
 *     (faceForRole): plain tables, no model, so setting an agent up works the same
 *     everywhere and can be tested;
 *   - the words a conversation with an agent is given: who it is, what its job is,
 *     and, for BeeZilla herself, who her agents are (agentPromptParts);
 *   - the rows (buzzy_agents, migration 0065) and the route /api/buzzy/agents.
 *
 * BeeZilla herself is never a row. The sidebar always starts with her, she cannot be
 * renamed, moved or deleted, and a conversation with no agent is hers (BZILLA below).
 *
 * Everything here is the person's own data, shown back only to them. Every query is
 * scoped by user_id, and an agent that belongs to someone else is answered exactly
 * like one that does not exist.
 */
import { randomBytes } from "node:crypto";
import type { Sql } from "@/lib/db";

// ── The roster ──────────────────────────────────────────────────────────────

export interface Creature {
  id: string;
  /** "Bunny" → Bunnyzilla. */
  word: string;
  /** The colour of the Talk button for the picture as drawn (look ''). */
  color: string;
}

/**
 * The creatures that have a picture. The bunny's colour is pink because the owner
 * said so ("the most prominent color is probably the pink in the ears"); the others
 * follow their picture. A new creature is one entry here plus
 * public/buzzy/zillas/<id>.webp (and, when there are colour versions,
 * <id>-<colour>.webp).
 */
export const CREATURES: Creature[] = [
  { id: "bee", word: "Bee", color: "#FFC107" },
  { id: "bunny", word: "Bunny", color: "#F08CA0" },
  { id: "bull", word: "Bull", color: "#E07B39" },
  { id: "frog", word: "Frog", color: "#8CB83A" },
];

export interface ZillaColor {
  name: string;
  /** Degrees on the colour wheel: what scripts/zilla-art.py moved the picture's hue to. */
  hue: number;
  hex: string;
}

/** hsl(hue, 75%, 58%) as #RRGGBB. */
function hslHex(hue: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return ("#" + to(r) + to(g) + to(b)).toUpperCase();
}

/** The twelve colours a Zilla comes in. The same names are in the picture file names. */
export const COLORS: ZillaColor[] = (
  [
    ["red", 358], ["orange", 24], ["yellow", 46], ["lime", 84], ["green", 125], ["teal", 168],
    ["sky", 200], ["blue", 224], ["indigo", 252], ["purple", 278], ["magenta", 306], ["pink", 336],
  ] as Array<[string, number]>
).map(([name, hue]) => ({ name, hue, hex: hslHex(hue, 0.75, 0.58) }));

export const creatureOf = (id: string): Creature | undefined => CREATURES.find((c) => c.id === id);
export const colorOf = (name: string): ZillaColor | undefined => COLORS.find((c) => c.name === name);

/** The picture for a creature: its own art when look is '', else a colour version. */
export function agentImage(creature: string, look: string): string {
  return `/buzzy/zillas/${creature}${look ? "-" + look : ""}.webp`;
}

/** The colour of an agent's button when nobody has chosen one: its look's, or the creature's. */
export function defaultColor(creature: string, look: string): string {
  return (look ? colorOf(look)?.hex : creatureOf(creature)?.color) ?? "#FFC107";
}

export type Size = "s" | "m" | "l";
const SIZES = new Set<string>(["s", "m", "l"]);

/** The most agents one person keeps. Hundreds are meant; this is the roof. */
export const AGENTS_MAX = 500;
/** What a request to the agents route may carry. */
export const AGENT_BODY_MAX_BYTES = 16 * 1024;

export const NAME_MAX = 40;
export const ROLE_MAX = 80;
export const INSTRUCTIONS_MAX = 800;

/** One agent as the sidebar and the Talk page see it. */
export interface Agent {
  id: string;
  name: string;
  creature: string;
  look: string;
  color: string;
  size: Size;
  /** What it helps with, in a few words. '' means it has no job yet. */
  role: string;
  /** The person's own words about the job, as they typed them. */
  instructions: string;
  /** One emoji for the job, or ''. */
  face: string;
  pos: number;
  /** True once it has a job. A greyed-out agent is one that is not ready. */
  ready: boolean;
  image: string;
  /** The first thing it says when a conversation with it opens. */
  opening: string;
  /** The conversation to carry on with, when there is one. */
  lastSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What a conversation needs to know about the agent speaking in it. */
export interface AgentTurn {
  id: string;
  name: string;
  role: string;
  instructions: string;
  face: string;
}

/**
 * BeeZilla herself: the executive assistant who works across everything and looks
 * after the agents. Never a row; the sidebar draws her first, at the large size.
 */
export const BZILLA = {
  id: "bzilla",
  name: "BeeZilla",
  creature: "bee",
  look: "",
  color: "#FFC107",
  size: "l" as Size,
  role: "your executive assistant",
  face: "",
  image: "/buzzy/zillas/bee.webp",
  ready: true,
};

// ── What the + button adds ──────────────────────────────────────────────────

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Bunnyzilla", or "Blue Bunnyzilla" for a colour version. */
export function defaultName(creature: string, look: string): string {
  const word = creatureOf(creature)?.word ?? cap(creature);
  return (look ? cap(look) + " " : "") + word + "zilla";
}

/** `base`, or `base 2`, `base 3`… when the person already has one by that name. */
export function uniqueName(base: string, taken: string[]): string {
  const lower = new Set(taken.map((n) => n.trim().toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const next = `${base} ${n}`;
    if (!lower.has(next.toLowerCase())) return next;
  }
}

/**
 * The order the + button hands out looks in: the owner's own art first (bunny, bull,
 * frog; the plain bee is BeeZilla), then one colour at a time across the four
 * creatures. Fifty-one in all, then it goes round again.
 */
function lookOrder(): Array<{ creature: string; look: string }> {
  const out: Array<{ creature: string; look: string }> = [
    { creature: "bunny", look: "" },
    { creature: "bull", look: "" },
    { creature: "frog", look: "" },
  ];
  for (const c of COLORS) for (const cr of CREATURES) out.push({ creature: cr.id, look: c.name });
  return out;
}

export interface DefaultAgent {
  creature: string;
  look: string;
  name: string;
  color: string;
  size: Size;
  image: string;
}

/** What + would add next, given the agents the person already has. */
export function nextDefault(existing: Array<{ creature: string; look: string; name?: string }>): DefaultAgent {
  const order = lookOrder();
  const used = new Set(existing.map((a) => `${a.creature}|${a.look}`));
  const pick = order.find((p) => !used.has(`${p.creature}|${p.look}`)) ?? order[existing.length % order.length]!;
  return {
    creature: pick.creature,
    look: pick.look,
    name: uniqueName(defaultName(pick.creature, pick.look), existing.map((a) => String(a.name ?? ""))),
    color: defaultColor(pick.creature, pick.look),
    size: "m",
    image: agentImage(pick.creature, pick.look),
  };
}

// ── Cleaning and validation ─────────────────────────────────────────────────

export type Refusal = { ok: false; status: number; code: string; error: string };
const no = (status: number, code: string, error: string): Refusal => ({ ok: false, status, code, error });

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
// Postgres text can't hold U+0000, and half of a surrogate pair (a cut in the middle of
// an emoji) would fail the whole write: both are replaced or removed.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// Control characters that are not white space (U+0000, a bell…): removed. White space of every
// kind, line breaks included, is collapsed to one space by line().
// eslint-disable-next-line no-control-regex -- deliberate: matches control bytes so they can be stripped
const NON_TEXT = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/g;

/** One tidy line: no control characters, spaces collapsed, cut at `max` whole characters. */
function line(v: unknown, max: number, noTags = false): string {
  let s = typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  s = s.replace(LONE_SURROGATE, "\uFFFD").replace(NON_TEXT, "");
  if (noTags) s = s.replace(/[<>]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join("").trim() : s;
}

const EMOJI_START = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3)/u;
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Exactly one emoji (a flag, a keycap and a skin-toned hand each count as one). */
export function isSingleEmoji(s: string): boolean {
  if (!s || s.length > 32) return false;
  const parts = Array.from(graphemes.segment(s));
  return parts.length === 1 && EMOJI_START.test(parts[0]!.segment);
}

/** The fields a person can set, as they are stored. */
export interface AgentFields {
  creature: string;
  look: string;
  name: string;
  color: string;
  size: Size;
  role: string;
  instructions: string;
  face: string;
}

/**
 * Check the fields that are present in `raw` and return those, cleaned. Absent keys are
 * left out, so the same check serves a new agent (the rest come from nextDefault) and a
 * change (the rest stay as they are).
 */
export function checkFields(raw: Record<string, unknown>): { ok: true; fields: Partial<AgentFields> } | Refusal {
  const f: Partial<AgentFields> = {};
  if (own(raw, "creature")) {
    const c = typeof raw.creature === "string" ? raw.creature : "";
    if (!creatureOf(c)) return no(400, "bad_creature", "There is no Zilla like that yet.");
    f.creature = c;
  }
  if (own(raw, "look")) {
    const l = raw.look === null || raw.look === undefined ? "" : raw.look;
    if (typeof l !== "string" || (l !== "" && !colorOf(l))) {
      return no(400, "bad_look", "That isn't one of the Zilla colours.");
    }
    f.look = l;
  }
  if (own(raw, "name")) {
    const n = line(raw.name, NAME_MAX, true);
    if (!n) return no(400, "bad_name", `Give it a name of 1 to ${NAME_MAX} characters.`);
    f.name = n;
  }
  if (own(raw, "color")) {
    const c = typeof raw.color === "string" ? raw.color.trim() : "";
    if (!/^#[0-9a-fA-F]{6}$/.test(c)) return no(400, "bad_color", "A colour is written like #F08CA0.");
    f.color = c.toUpperCase();
  }
  if (own(raw, "size")) {
    const s = typeof raw.size === "string" ? raw.size : "";
    if (!SIZES.has(s)) return no(400, "bad_size", "Size is s (small), m (medium) or l (large).");
    f.size = s as Size;
  }
  if (own(raw, "role")) f.role = line(raw.role, ROLE_MAX, true);
  if (own(raw, "instructions")) f.instructions = line(raw.instructions, INSTRUCTIONS_MAX);
  if (own(raw, "face")) {
    const e = raw.face === null || raw.face === undefined ? "" : raw.face;
    if (typeof e !== "string" || (e !== "" && !isSingleEmoji(e.trim()))) {
      return no(400, "bad_face", "A face is a single emoji, or nothing.");
    }
    f.face = e.trim();
  }
  return { ok: true, fields: f };
}

// ── The job, from the person's own words ────────────────────────────────────

// Said before the job itself. Each is taken off the front, in any order and any number,
// until what is left starts with the job: "I want you to help me with my calendars"
// loses "I want you to", then "help me with", then "my", and leaves "calendars".
const LEAD_INS: RegExp[] = [
  /^(?:ok(?:ay)?|alright|hi|hello|hey|so|um|uh)\b[,!:]?(?:\s+|$)/i,
  /^(?:please|pls|kindly)\b,?(?:\s+|$)/i,
  /^(?:can|could|would|will)\s+you(?:\s+please|\s+kindly)?(?:\s+|$)/i,
  /^i['\u2019]?d\s+(?:like|love)\s+you\s+to(?:\s+|$)/i,
  /^i\s+(?:want|need|would\s+like|would\s+love|ask)\s+you\s+to(?:\s+|$)/i,
  /^i['\u2019]?m\s+(?:going\s+to\s+)?(?:need|want)\s+you\s+to(?:\s+|$)/i,
  /^you(?:['\u2019]re|\s+are)\s+(?:going\s+to\s+be\s+|gonna\s+be\s+|now\s+|to\s+be\s+)?(?:in\s+charge\s+of|responsible\s+for|handling|managing|taking\s+care\s+of|looking\s+after|running|my|our|the)(?:\s+|$)/i,
  /^(?:your|the|my)\s+(?:job|role|task|work|purpose|mission)\s+(?:is|will\s+be)(?:\s+to)?(?:\s+|$)/i,
  /^be\s+(?:in\s+charge\s+of|responsible\s+for|my|our|the)(?:\s+|$)/i,
  /^help(?:ing)?\s+(?:(?:me|us)\s+)?(?:out\s+)?(?:with|on)(?:\s+|$)/i,
  /^(?:manage|handle|take\s+care\s+of|look\s+after|keep\s+track\s+of|keep\s+on\s+top\s+of|stay\s+on\s+top\s+of|work\s+on|focus\s+on|organi[sz]e|oversee|deal\s+with|take\s+charge\s+of|take\s+over)(?:\s+|$)/i,
  /^run\s+(?=(?:my|our|the)\b)/i,
  /^to\s+(?=(?:help|manage|handle|take|look|keep|stay|work|focus|be|run|oversee|deal)\b)/i,
  /^(?:all\s+of\s+my|all\s+of\s+our|all\s+my|all\s+our|my|our|the|your)(?:\s+|$)/i,
];
const NOT_A_JOB = new Set(["ok", "okay", "yes", "no", "yeah", "yep", "nope", "hi", "hello", "hey", "thanks", "thank you", "sure", "hmm", "um", "idk", "please", "pls"]);

function jobFromSentence(sentence: string): string {
  let t = sentence.trim().replace(/^["'\u201C\u2018]+|["'\u201D\u2019]+$/g, "").trim();
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const re of LEAD_INS) {
      const next = t.replace(re, "");
      if (next !== t) { t = next.trim(); changed = true; }
    }
    if (!changed) break;
  }
  t = t.replace(/\s+(?:for\s+me|for\s+us|please|pls|thanks|thank\s+you)$/i, "");
  t = t.replace(/[\s.,;:!?…-]+$/, "").replace(/^[\s.,;:!?…-]+/, "").trim();
  return NOT_A_JOB.has(t.toLowerCase()) ? "" : t;
}

/**
 * The short job the sidebar shows after "helps with", from what the person said. "You're
 * in charge of my to-do list" → "to-do list"; "Take care of my real estate business" →
 * "real estate business"; "calendars" → "calendars". The first sentence that holds a
 * job is the job, so a greeting in front of it doesn't matter. '' when there isn't one
 * (an empty reply, or only "please"): the agent asks again instead of saving nothing.
 */
export function roleFromText(input: unknown): string {
  const text = typeof input === "string" ? input : "";
  const flat = text.replace(LONE_SURROGATE, "\uFFFD").replace(NON_TEXT, "");
  // Sentences end at a new line, or at . ! ? ; when a space (or the end) follows: "to-do",
  // "e.g." and "3.5" stay in one piece.
  const sentences = flat.split(/[\n\r\u2028\u2029]+|[.!?;]+(?:\s+|$)/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    let job = jobFromSentence(s);
    if (!job) continue;
    // Lower-case the first letter, unless the first word is an acronym or has capitals
    // of its own (CRM, HVAC, iPhone, To-Do), or the capital is a name: a job that came
    // after a lead-in ("run my Etsy shop", "help with Sarah's schedule") keeps what was typed.
    const first = job.split(/\s+/)[0] ?? "";
    const letters = first.replace(/[^A-Za-z]/g, "");
    const startsTheSentence = s.toLowerCase().startsWith(job.toLowerCase().slice(0, 12));
    if (startsTheSentence && /^[A-Z]/.test(job) && letters.length > 0 && letters.slice(1) === letters.slice(1).toLowerCase()) {
      job = job.charAt(0).toLowerCase() + job.slice(1);
    }
    job = job.replace(/[<>]/g, "");
    const chars = Array.from(job);
    if (chars.length > ROLE_MAX) {
      let cut = chars.slice(0, ROLE_MAX).join("");
      const space = cut.lastIndexOf(" ");
      if (space >= ROLE_MAX / 2) cut = cut.slice(0, space);
      job = cut.replace(/[\s.,;:!?…-]+$/, "");
    }
    return job.trim();
  }
  return "";
}

// ── The face, from the job ──────────────────────────────────────────────────

/**
 * An emoji for a job. First match wins, so the specific rows come first ("shopping
 * list" before "shopping", "real estate" before "estate", "video games" before "video").
 */
const FACES: Array<[RegExp, string]> = [
  [/\b(?:to-?dos?|tasks?|checklists?|reminders?)\b/i, "✅"],
  [/\b(?:calendars?|schedul\w*|appointments?|meetings?|agenda)\b/i, "🗓️"],
  [/\b(?:e-?mails?|gmail|inbox(?:es)?|mail)\b/i, "✉️"],
  [/\btax(?:es)?\b/i, "🧾"],
  [/\b(?:budgets?|money|financ\w*|bills?|expenses?|banking|bank|invoic\w*|payments?|savings?|invest\w*|accounting|bookkeeping)\b/i, "💰"],
  [/\bhotels?\b/i, "🏨"],
  [/\b(?:travel\w*|trips?|vacations?|flights?|holidays?|itinerar\w*|airlines?|cruises?)\b/i, "✈️"],
  [/\b(?:running|jogging|marathons?|runs?)\b/i, "🏃"],
  [/\b(?:fitness|workouts?|gym|exercis\w*|weights?)\b/i, "🏋️"],
  [/\b(?:health\w*|medical|doctors?|medications?|medicines?|prescriptions?|symptoms?|therapy)\b/i, "🩺"],
  [/\b(?:groceries|grocery|shopping\s+lists?)\b/i, "🛒"],
  [/\b(?:meals?|recipes?|cook\w*|dinners?|lunch\w*|breakfast|baking|kitchen|food|menus?)\b/i, "🍳"],
  [/\bshopping\b/i, "🛍️"],
  [/\breal\s+estate\b/i, "🏠"],
  [/\b(?:repairs?|maintenance|plumb\w*|handyman|renovat\w*|diy|home\s+improvement)\b/i, "🔧"],
  [/\b(?:propert(?:y|ies)|landlords?|rentals?|tenants?|houses?|home|mortgages?|apartments?)\b/i, "🏠"],
  [/\b(?:languages?|spanish|french|german|japanese|chinese|italian)\b/i, "🗣️"],
  [/\b(?:school|homework|stud(?:y|ying|ies)|learning|class(?:es)?|courses?|education|exams?|tutor\w*)\b/i, "📚"],
  [/\b(?:kids?|child(?:ren)?|parent\w*|babys?|babies|toddlers?|nanny|daycare)\b/i, "🧸"],
  [/\b(?:pets?|dogs?|pupp(?:y|ies))\b/i, "🐶"],
  [/\b(?:cats?|kittens?)\b/i, "🐱"],
  [/\b(?:garden\w*|plants?|lawn|yard)\b/i, "🌱"],
  [/\b(?:music|songs?|playlists?|guitar|piano)\b/i, "🎵"],
  [/\b(?:photos?|photograph\w*|pictures?|camera)\b/i, "📷"],
  [/\b(?:games?|gaming|video\s+games?)\b/i, "🎮"],
  [/\b(?:videos?|films?|movies?|youtube|streaming)\b/i, "🎬"],
  [/\b(?:social\s+media|instagram|twitter|tiktok|facebook|linkedin)\b/i, "📱"],
  [/\b(?:marketing|ads?|advertis\w*|campaigns?|seo|promotion)\b/i, "📣"],
  [/\b(?:reading|audiobooks?)\b/i, "📖"],
  [/\b(?:writing|blogs?|articles?|essays?|books?|novels?|stor(?:y|ies)|newsletters?|copywriting|poems?)\b/i, "✍️"],
  [/\b(?:news|headlines?|current\s+events)\b/i, "📰"],
  [/\b(?:legal|contracts?|lawyers?|attorneys?|law|lawsuits?|compliance)\b/i, "⚖️"],
  [/\binsurance\b/i, "☂️"],
  [/\b(?:cars?|vehicles?|driving|auto|truck|motorcycle|oil\s+change)\b/i, "🚗"],
  [/\b(?:jobs?|careers?|resum(?:e|es)|résumés?|cv|interviews?|hiring|recruit\w*)\b/i, "💼"],
  [/\b(?:sales|customers?|clients?|crm|leads?|prospects?)\b/i, "🤝"],
  [/\b(?:research\w*|investigat\w*|fact-?check\w*)\b/i, "🔎"],
  [/\b(?:cod(?:e|ing)|programm\w*|software|developers?|apps?|websites?|bugs?|github)\b/i, "💻"],
  [/\b(?:sleep\w*|bedtime|insomnia|naps?)\b/i, "😴"],
  [/\b(?:meditat\w*|mindful\w*|yoga|relax\w*|stress)\b/i, "🧘"],
  [/\b(?:gifts?|presents?|birthdays?|anniversar\w*)\b/i, "🎁"],
  [/\b(?:events?|part(?:y|ies)|wedding\w*|celebrat\w*|reunions?)\b/i, "🎉"],
  [/\b(?:weather|forecasts?)\b/i, "⛅"],
  [/\b(?:clean\w*|chores?|laundry|housekeeping|tidy\w*)\b/i, "🧹"],
  [/\b(?:notes?|ideas?|brainstorm\w*|journal\w*|diary)\b/i, "💡"],
  [/\b(?:contacts?|address\s+book|friends|family|relationships?|network\w*)\b/i, "👥"],
  [/\b(?:passwords?|logins?|security)\b/i, "🔑"],
];

/** Every emoji the table can give, for a test that each one is accepted as a face. */
export const FACE_EMOJIS: string[] = [...new Set([...FACES.map(([, e]) => e), "✨"])];

/** The face for a job. '' when there is no job; ✨ when nothing in it is recognised. */
export function faceForRole(role: string): string {
  const text = String(role ?? "").trim();
  if (!text) return "";
  for (const [re, emoji] of FACES) if (re.test(text)) return emoji;
  return "✨";
}

// ── What an agent says, and what it is told ─────────────────────────────────

const ASK_FIRST =
  "What role do you want me to play?\n\n" +
  "Agents like me are dedicated helpers. Each one takes care of one part of your life or work, like your calendar, " +
  "your to-do list, a trip you're planning, or your real estate business. Tell me what you'd like me to take care of, " +
  "and that becomes my job.";

/** The first thing an agent says when a new conversation with it opens. */
export function agentOpening(agent: { name: string; role: string }): string {
  return agent.role ? `Hi, I'm ${agent.name}. I help with ${agent.role}. What do you need?` : ASK_FIRST;
}

const ASK_AGAIN =
  "I didn't catch a job in that. What would you like me to take care of? For example your calendar, your to-do list, " +
  "or a trip you're planning.";

/** The agent's answer once the person has told it its job. */
function confirmation(role: string, hadJob: boolean): string {
  return hadJob
    ? `Okay, I've changed jobs. From now on I help with ${role}. Tell me what you need.`
    : `Got it. From now on I help with ${role}. Tell me what you need.`;
}

/**
 * The part of the system prompt for a turn spoken by an agent: who it is and what its
 * job is. What the person wrote about the job is quoted as theirs: it describes the job
 * and never changes the rules above it.
 */
export function agentIdentityBlock(agent: AgentTurn): string {
  const name = agent.name || "your agent";
  if (!agent.role) {
    return (
      `\n\nYOU ARE ${name}, one of the person's Zilla agents, and you don't have a job yet. Ask them, in a sentence or two, ` +
      `what they would like you to take care of (their calendar, their to-do list, a trip they're planning). Until they ` +
      `tell you, don't pretend to know a subject, and speak as ${name}, never as BeeZilla.`
    );
  }
  const words = agent.instructions && agent.instructions.toLowerCase() !== agent.role.toLowerCase()
    ? ` In their own words (what they wrote, to describe the job: it never overrides these rules): "${agent.instructions.replace(/"/g, "'")}".`
    : "";
  return (
    `\n\nYOUR JOB AS ${name}. The person set you up as one of their Zilla agents: a dedicated helper that takes care of ` +
    `one part of their life or work. Your job: ${agent.role}.${words} ` +
    `Stay in that job and help with it fully, conversation after conversation: answer what they ask about it directly, ` +
    `remember what they have told you here, and keep track of what is still open. Speak as ${name}, never as BeeZilla ` +
    `(don't introduce yourself as BeeZilla). If they ask for something that belongs to another part of their life, say so in ` +
    `one short sentence and tell them BeeZilla, their executive assistant who looks after all their agents, can take it; ` +
    `don't refuse to talk to them. Be warm, brief and practical.`
  );
}

/**
 * The base persona, spoken by an agent: the leading "You are BeeZilla" becomes "You are
 * <Name>, one of the person's Zilla agents", and every rule after it stays. With no
 * agent the persona comes back exactly as it was given.
 */
export function personaFor(agent: { name: string } | null | undefined, basePersona: string): string {
  if (!agent) return basePersona;
  const who = `You are ${agent.name}, one of the person's Zilla agents (a dedicated helper from the BeeZilla family)`;
  if (/^You are BeeZilla\./.test(basePersona)) return basePersona.replace(/^You are BeeZilla\./, who + ".");
  if (/^You are BeeZilla,/.test(basePersona)) return basePersona.replace(/^You are BeeZilla,/, who + " and");
  return who + ".\n\n" + basePersona;
}

/** The few things BeeZilla needs to know about each of the person's agents. */
export interface ReadyAgent {
  name: string;
  role: string;
}

const ROSTER_LINES = 20;

/**
 * For BeeZilla's own turns: who the person's agents are, so she can talk about them
 * across everything. Only agents that have a job are listed. '' when there are none,
 * which leaves a person without agents exactly as before.
 */
export function agentsRosterBlock(agents: ReadyAgent[]): string {
  const ready = agents.filter((a) => a && a.name && a.role);
  if (!ready.length) return "";
  const lines = ready.slice(0, ROSTER_LINES).map((a) => `- ${a.name}: helps with ${a.role}`);
  const more = ready.length > ROSTER_LINES ? `\n- …and ${ready.length - ROSTER_LINES} more.` : "";
  return (
    `\n\nTHE PERSON'S ZILLA AGENTS. They have dedicated helpers, each looking after one part of their life or work. You are ` +
    `BeeZilla, their executive assistant: you work across all of it and look after these agents (names and jobs are what the ` +
    `person typed):\n${lines.join("\n")}${more}\n` +
    `When what they ask clearly belongs to one of these, say which agent looks after it: they open an agent by clicking its ` +
    `Zilla in the sidebar on the left. Don't say you have asked an agent, passed something on or checked with one: you can't ` +
    `do that yet, and saying so would be false.`
  );
}

/**
 * Everything the agent changes about one turn's prompt, in one place so it can be
 * tested: the persona (spoken by the agent, or BeeZilla's own, untouched) and the
 * section that follows it (the agent's job, or BeeZilla's agent list). A person with no
 * agents gets { persona: basePersona, section: "" }, byte for byte.
 */
export function agentPromptParts(
  agent: AgentTurn | null | undefined,
  basePersona: string,
  ready: ReadyAgent[],
): { persona: string; section: string } {
  if (agent) return { persona: personaFor(agent, basePersona), section: agentIdentityBlock(agent) };
  return { persona: basePersona, section: agentsRosterBlock(ready) };
}

// ── Rows ────────────────────────────────────────────────────────────────────

interface AgentRow {
  id: string;
  creature: string;
  look: string;
  name: string;
  color: string;
  size: string;
  role: string;
  instructions: string;
  face: string;
  pos: number | string;
  created_at: Date | string;
  updated_at: Date | string;
  last_session_id?: string | null;
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));

function rowToAgent(r: AgentRow): Agent {
  const role = String(r.role ?? "");
  return {
    id: r.id,
    name: r.name,
    creature: r.creature,
    look: r.look,
    color: r.color,
    size: (SIZES.has(r.size) ? r.size : "m") as Size,
    role,
    instructions: String(r.instructions ?? ""),
    face: String(r.face ?? ""),
    pos: Number(r.pos) || 0,
    ready: role !== "",
    image: agentImage(r.creature, r.look),
    opening: agentOpening({ name: r.name, role }),
    lastSessionId: r.last_session_id ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function newId(): string {
  // 12 characters of base 36 from random bytes: ag_k3j9x0w2m1qa
  const n = Array.from(randomBytes(12), (b) => (b % 36).toString(36)).join("");
  return "ag_" + n;
}

const AGENT_ID = /^ag_[a-z0-9]{12}$/;
const notFound = () => no(404, "not_found", "There is no agent like that on your account.");

/**
 * Give a person their starter agent: one greyed-out bunny, made once. The marker and
 * the agent are written by one statement, so two first visits at the same moment make
 * one bunny, and a bunny that was deleted never comes back. True when this call made it.
 */
export async function ensureSeeded(sql: Sql, userId: string): Promise<boolean> {
  const done = await sql<{ user_id: string }>`SELECT user_id FROM buzzy_agent_seed WHERE user_id = ${userId}`;
  if (done.length) return false;
  const bunny = creatureOf("bunny")!;
  const made = await sql<{ id: string }>`
    WITH marker AS (
      INSERT INTO buzzy_agent_seed (user_id) VALUES (${userId})
      ON CONFLICT (user_id) DO NOTHING
      RETURNING user_id
    )
    INSERT INTO buzzy_agents (id, user_id, creature, look, name, color, size, role, instructions, face, pos)
    SELECT ${newId()}::text, marker.user_id, 'bunny'::text, ''::text, ${defaultName("bunny", "")}::text,
           ${bunny.color}::text, 'm'::text, ''::text, ''::text, ''::text, 0
    FROM marker
    RETURNING id
  `;
  return made.length > 0;
}

/** The person's agents, in the order they sit in the sidebar. Seeds the starter on the first look. */
export async function listAgents(sql: Sql, userId: string): Promise<Agent[]> {
  await ensureSeeded(sql, userId);
  const rows = await sql<AgentRow>`
    SELECT a.id, a.creature, a.look, a.name, a.color, a.size, a.role, a.instructions, a.face, a.pos,
           a.created_at, a.updated_at,
           (SELECT s.id FROM buzzy_sessions s
             WHERE s.user_id = a.user_id AND s.agent_id = a.id
             ORDER BY s.updated_at DESC LIMIT 1) AS last_session_id
    FROM buzzy_agents a
    WHERE a.user_id = ${userId}
    ORDER BY a.pos ASC, a.created_at ASC, a.id ASC
    LIMIT ${AGENTS_MAX}
  `;
  return rows.map(rowToAgent);
}

async function getAgent(sql: Sql, userId: string, id: string): Promise<Agent | null> {
  if (!AGENT_ID.test(id)) return null;
  const rows = await sql<AgentRow>`
    SELECT a.id, a.creature, a.look, a.name, a.color, a.size, a.role, a.instructions, a.face, a.pos,
           a.created_at, a.updated_at,
           (SELECT s.id FROM buzzy_sessions s
             WHERE s.user_id = a.user_id AND s.agent_id = a.id
             ORDER BY s.updated_at DESC LIMIT 1) AS last_session_id
    FROM buzzy_agents a
    WHERE a.id = ${id} AND a.user_id = ${userId}
  `;
  return rows[0] ? rowToAgent(rows[0]) : null;
}

/** Add an agent. Anything not given comes from nextDefault. */
export async function createAgent(
  sql: Sql,
  userId: string,
  raw: Record<string, unknown>,
): Promise<{ ok: true; agent: Agent } | Refusal> {
  const checked = checkFields({
    ...(own(raw, "creature") ? { creature: raw.creature } : {}),
    ...(own(raw, "look") ? { look: raw.look } : {}),
    ...(own(raw, "name") ? { name: raw.name } : {}),
    ...(own(raw, "size") ? { size: raw.size } : {}),
    ...(own(raw, "color") ? { color: raw.color } : {}),
  });
  if (!checked.ok) return checked;
  await ensureSeeded(sql, userId);
  const have = await sql<{ creature: string; look: string; name: string }>`
    SELECT creature, look, name FROM buzzy_agents WHERE user_id = ${userId}
  `;
  if (have.length >= AGENTS_MAX) {
    return no(409, "too_many", `You have ${AGENTS_MAX} agents, the most one account keeps. Remove one before you add another.`);
  }
  const f = checked.fields;
  const dflt = nextDefault(have);
  // A picture is chosen as a pair: asking for a creature alone means its own art.
  const creature = f.creature ?? dflt.creature;
  const look = f.look ?? (f.creature !== undefined ? "" : dflt.look);
  if (creature === "bee" && look === "") {
    return no(400, "bee_reserved", "The plain yellow bee is BeeZilla herself. Pick a colour for this one.");
  }
  const picked = f.creature !== undefined || f.look !== undefined;
  const name = f.name ?? (picked ? uniqueName(defaultName(creature, look), have.map((a) => a.name)) : dflt.name);
  const color = f.color ?? defaultColor(creature, look);
  const size = f.size ?? "m";
  const next = await sql<{ n: number }>`SELECT COALESCE(MAX(pos), -1) + 1 AS n FROM buzzy_agents WHERE user_id = ${userId}`;
  const id = newId();
  const rows = await sql<AgentRow>`
    INSERT INTO buzzy_agents (id, user_id, creature, look, name, color, size, role, instructions, face, pos)
    VALUES (${id}, ${userId}, ${creature}, ${look}, ${name}, ${color}, ${size}, '', '', '', ${Number(next[0]?.n ?? 0)})
    RETURNING id, creature, look, name, color, size, role, instructions, face, pos, created_at, updated_at
  `;
  return { ok: true, agent: rowToAgent(rows[0]!) };
}

/**
 * Change an agent. Only the fields that are sent change. A new look or creature with no
 * colour sent takes that look's colour; a new job with no face sent takes the job's
 * face, unless the person had picked a face of their own.
 */
export async function updateAgent(
  sql: Sql,
  userId: string,
  id: string,
  raw: Record<string, unknown>,
): Promise<{ ok: true; agent: Agent } | Refusal> {
  const now = await getAgent(sql, userId, id);
  if (!now) return notFound();
  const checked = checkFields(raw);
  if (!checked.ok) return checked;
  const f = checked.fields;
  if (!Object.keys(f).length) {
    return no(400, "nothing_to_change", "Say what to change: its name, colour, size, job or face.");
  }
  const creature = f.creature ?? now.creature;
  const look = f.look ?? now.look;
  if (creature === "bee" && look === "") {
    return no(400, "bee_reserved", "The plain yellow bee is BeeZilla herself. Pick a colour for this one.");
  }
  const color = f.color ?? (f.creature !== undefined || f.look !== undefined ? defaultColor(creature, look) : now.color);
  const role = f.role ?? now.role;
  let face = now.face;
  if (f.face !== undefined) face = f.face;
  else if (f.role !== undefined && (now.face === "" || now.face === faceForRole(now.role))) face = faceForRole(role);
  const rows = await sql<AgentRow>`
    UPDATE buzzy_agents
    SET creature = ${creature}, look = ${look}, name = ${f.name ?? now.name}, color = ${color},
        size = ${f.size ?? now.size}, role = ${role}, instructions = ${f.instructions ?? now.instructions},
        face = ${face}, updated_at = now()
    WHERE id = ${id} AND user_id = ${userId}
    RETURNING id, creature, look, name, color, size, role, instructions, face, pos, created_at, updated_at
  `;
  if (!rows[0]) return notFound();
  return { ok: true, agent: { ...rowToAgent(rows[0]), lastSessionId: now.lastSessionId } };
}

/** Remove an agent. Its conversations stay in History as ordinary ones. */
export async function deleteAgent(sql: Sql, userId: string, id: string): Promise<boolean> {
  if (!AGENT_ID.test(id)) return false;
  const gone = await sql<{ id: string }>`DELETE FROM buzzy_agents WHERE id = ${id} AND user_id = ${userId} RETURNING id`;
  if (!gone.length) return false;
  await sql`UPDATE buzzy_sessions SET agent_id = NULL WHERE user_id = ${userId} AND agent_id = ${id}`;
  return true;
}

export type IdentityResult =
  | { ok: true; saved: true; agent: Agent; reply: string }
  | { ok: true; saved: false; reply: string }
  | Refusal;

/**
 * The person tells an agent its job. The words become the job and the face; the agent
 * answers in its own voice. When the conversation is named (and is theirs) the whole
 * exchange is kept in it, from the agent's first question, so History shows it. With no
 * job in the words the agent asks again and nothing is saved.
 */
export async function setIdentity(
  sql: Sql,
  userId: string,
  id: string,
  text: unknown,
  sessionId?: unknown,
): Promise<IdentityResult> {
  const agent = await getAgent(sql, userId, id);
  if (!agent) return notFound();
  const said = line(text, 2000);
  // The job is read from the words as typed (a new line ends a sentence); `said` is the tidy copy kept.
  const role = roleFromText(typeof text === "string" ? text.slice(0, 2000) : "");
  const reply = role ? confirmation(role, agent.role !== "") : ASK_AGAIN;

  let saved: Agent | null = null;
  if (role) {
    const rows = await sql<AgentRow>`
      UPDATE buzzy_agents
      SET role = ${role}, instructions = ${line(said, INSTRUCTIONS_MAX)}, face = ${faceForRole(role)}, updated_at = now()
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING id, creature, look, name, color, size, role, instructions, face, pos, created_at, updated_at
    `;
    if (rows[0]) saved = { ...rowToAgent(rows[0]), lastSessionId: agent.lastSessionId };
  }

  const sid = typeof sessionId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(sessionId) ? sessionId : "";
  if (sid && said) {
    const mine = await sql<{ id: string }>`SELECT id FROM buzzy_sessions WHERE id = ${sid} AND user_id = ${userId}`;
    if (mine.length) {
      const before = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM buzzy_chat_messages WHERE user_id = ${userId} AND session_id = ${sid}
      `;
      // clock_timestamp(), not now(): each row is its own moment, so they sort in the order said.
      if (!Number(before[0]?.n ?? 0)) {
        await sql`
          INSERT INTO buzzy_chat_messages (user_id, job_id, session_id, role, content, created_at)
          VALUES (${userId}, NULL, ${sid}, 'assistant', ${agent.opening}, clock_timestamp())
        `;
      }
      await sql`
        INSERT INTO buzzy_chat_messages (user_id, job_id, session_id, role, content, created_at)
        VALUES (${userId}, NULL, ${sid}, 'user', ${said}, clock_timestamp())
      `;
      await sql`
        INSERT INTO buzzy_chat_messages (user_id, job_id, session_id, role, content, created_at)
        VALUES (${userId}, NULL, ${sid}, 'assistant', ${reply}, clock_timestamp())
      `;
      // This conversation is the agent's, if it wasn't already someone's.
      await sql`
        UPDATE buzzy_sessions SET agent_id = COALESCE(agent_id, ${id}), updated_at = now()
        WHERE id = ${sid} AND user_id = ${userId}
      `;
    }
  }
  return saved ? { ok: true, saved: true, agent: saved, reply } : { ok: true, saved: false, reply };
}

/**
 * The agent a conversation belongs to, or null: an ordinary BeeZilla conversation, an
 * agent that has since been deleted, or a conversation that isn't the person's. The
 * session is the authority when a turn is answered, never a field in the request.
 */
export async function agentForSession(sql: Sql, userId: string, sessionId: string): Promise<Agent | null> {
  if (!sessionId) return null;
  const rows = await sql<AgentRow>`
    SELECT a.id, a.creature, a.look, a.name, a.color, a.size, a.role, a.instructions, a.face, a.pos,
           a.created_at, a.updated_at
    FROM buzzy_sessions s
    JOIN buzzy_agents a ON a.id = s.agent_id AND a.user_id = s.user_id
    WHERE s.id = ${sessionId} AND s.user_id = ${userId}
  `;
  return rows[0] ? rowToAgent(rows[0]) : null;
}

/** Is this agent the person's? For a conversation that is about to be tagged with it. */
export async function ownsAgent(sql: Sql, userId: string, id: string): Promise<boolean> {
  if (!AGENT_ID.test(id)) return false;
  const rows = await sql<{ id: string }>`SELECT id FROM buzzy_agents WHERE id = ${id} AND user_id = ${userId}`;
  return rows.length > 0;
}

/** The agents that have a job, for BeeZilla's own turns. Never seeds, never throws on an older database. */
export async function readyAgents(sql: Sql, userId: string): Promise<ReadyAgent[]> {
  const rows = await sql<{ name: string; role: string }>`
    SELECT name, role FROM buzzy_agents
    WHERE user_id = ${userId} AND role <> ''
    ORDER BY pos ASC, created_at ASC, id ASC
    LIMIT ${ROSTER_LINES + 1}
  `;
  return rows;
}

// ── The route ───────────────────────────────────────────────────────────────

export interface AgentsReply {
  status: number;
  body: Record<string, unknown>;
}
const reply = (status: number, body: Record<string, unknown>): AgentsReply => ({ status, body });
const refuse = (r: Refusal): AgentsReply => reply(r.status, { ok: false, error: r.error, code: r.code });

/**
 * /api/buzzy/agents… for a signed-in person (chat.nitro.ts checks the session and reads
 * the body; `rest` is the path after /api/buzzy/agents).
 *
 *   GET  /                   { bzilla, agents, next, colors, creatures }
 *   POST /                   add one: { creature?, look?, name?, size?, color? } → 201 { agent }
 *   PATCH /<id>              change: { name?, color?, size?, role?, instructions?, face?, look?, creature? }
 *   DELETE /<id>             remove it
 *   POST /<id>/identity      tell it its job: { text, sessionId? } → { saved, agent?, reply }
 */
export async function agentsRoute(
  sql: Sql,
  userId: string,
  method: string,
  rest: string,
  body: unknown,
): Promise<AgentsReply> {
  const parts = String(rest ?? "").split("/").filter(Boolean);
  const obj = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;

  if (parts.length === 0) {
    if (method === "GET") {
      const agents = await listAgents(sql, userId);
      return reply(200, {
        ok: true,
        bzilla: BZILLA,
        agents,
        next: nextDefault(agents),
        colors: COLORS.map((c) => ({ name: c.name, hex: c.hex })),
        creatures: CREATURES.map((c) => ({ id: c.id, word: c.word, name: c.word + "zilla", color: c.color, image: agentImage(c.id, "") })),
      });
    }
    if (method === "POST") {
      const made = await createAgent(sql, userId, obj);
      return made.ok ? reply(201, { ok: true, agent: made.agent }) : refuse(made);
    }
    return reply(405, { ok: false, error: "Use GET or POST.", code: "method_not_allowed" });
  }

  const id = parts[0]!;
  if (parts.length === 1) {
    if (method === "PATCH") {
      const changed = await updateAgent(sql, userId, id, obj);
      return changed.ok ? reply(200, { ok: true, agent: changed.agent }) : refuse(changed);
    }
    if (method === "DELETE") {
      return (await deleteAgent(sql, userId, id)) ? reply(200, { ok: true }) : refuse(notFound());
    }
    return reply(405, { ok: false, error: "Use PATCH or DELETE.", code: "method_not_allowed" });
  }

  if (parts.length === 2 && parts[1] === "identity") {
    if (method !== "POST") return reply(405, { ok: false, error: "Use POST.", code: "method_not_allowed" });
    const out = await setIdentity(sql, userId, id, obj.text, obj.sessionId);
    if (!out.ok) return refuse(out);
    return reply(200, out.saved ? { ok: true, saved: true, agent: out.agent, reply: out.reply } : { ok: true, saved: false, reply: out.reply });
  }

  return reply(404, { ok: false, error: "There is no such agents page.", code: "not_found" });
}
