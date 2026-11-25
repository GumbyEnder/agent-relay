/**
 * Changing a picture by talking about it, and knowing what this conversation made.
 *
 * Owner, 2026-11-19: "anything you've created with it in the same session, it should
 * be able to see as context. So let's say we make an image together. I can iterate
 * on that image by just talking about the image. It's going to have the full context."
 *
 * Before this, "make the sky darker" after a picture of a house drew a brand-new
 * picture from those four words alone (a dark sky, no house), or, being short, was
 * not read as a picture request at all and the reply only promised a change.
 *
 *  - A turn that reads as a change to the newest picture of the conversation is drawn
 *    FROM that picture: it goes to the picture maker as the reference image, with the
 *    change as the instruction (`isPictureChange`, `changePrompt`).
 *  - A new subject ("draw me a cat", "make a logo for my bakery") is a new picture
 *    (`isNewPictureAsk`).
 *  - Everything the conversation made is listed for the model, oldest first, with the
 *    words that asked for it, so "the second picture" or "that song" means something
 *    (`madeThingsSection`). No file names: the model repeats whatever name it is handed.
 */

/** One file this conversation made or was given (a buzzy_assets row). */
export interface MadeThing {
  id: number;
  filename: string;
  contentType: string | null;
  createdAt: string | Date;
  /** The person's words that asked for it, when one message did. */
  brief?: string | null;
}

// Words people put in front of a request: "ok", "now", "can you", "I'd like you to"…
const LEAD =
  String.raw`^\s*(?:(?:ok(?:ay)?|alright|all right|great|nice|cool|good|perfect|awesome|love it|i love it|hmm+|um+|uh+|yes|yeah|yep|and|so|now|then|also|actually|wait|oh|ah|but|please|pls|hey|beezilla|bee zilla)[\s,.!-]+)*`;
const ASK =
  String.raw`(?:(?:can|could|would|will) you(?: please)?\s+|(?:let'?s|lets)\s+|i(?:'d| would)? (?:like|want|need) (?:you )?(?:to\s+)?|please\s+|try (?:and\s+|to\s+)?|go ahead and\s+)?`;
// Verbs that change something already there. "make" is only a change when it
// works on the picture ("make it…", "make the sky…"); "make me a…" is a new one.
const CHANGE_VERB =
  String.raw`(?:make (?:it|the|this|that|him|her|them|everything|all|its|his|their|some|more|less|a bit|it's|its)\b|change|turn|add|remove|take (?:out|away|off)|get rid of|put (?:a|an|some|the|more|less|it in the|them in the)\b|give (?:it|the|this|that|him|her|them|everything)\b|replace|swap|move|zoom(?: in| out)?|crop|brighten|darken|lighten|recolou?r|colou?r|keep (?:the|it|everything|all)\b|redo|fix|switch|flip|mirror|rotate|widen|shrink|enlarge|blur|sharpen|soften|lose|drop|delete|erase|include|insert|bring|raise|lower|increase|decrease|reduce|tone (?:it )?(?:down|up)|do (?:it|that|this|one) (?:again|but|with|without|in|at))\b`;
const CHANGE_START = new RegExp(LEAD + ASK + CHANGE_VERB, "i");

// A short tweak with no verb: "darker", "now at night", "same but bigger",
// "in watercolour", "another version", "try again".
const TWEAK = new RegExp(
  LEAD +
    String.raw`(?:(?:a (?:bit|little|lot)\s+)?(?:darker|lighter|brighter|bigger|smaller|wider|taller|shorter|warmer|cooler|softer|sharper|simpler|busier|calmer|happier|sadder|scarier|cuter|older|younger|redder|bluer|greener)|(?:a (?:bit|little|lot)\s+)?(?:more|less)\s+\w+|at (?:night|sunset|sunrise|dawn|dusk|noon|midnight|golden hour)|in (?:the )?(?:winter|summer|spring|autumn|fall|rain|snow|fog|watercolou?r|pencil|charcoal|oil paint|black and white|colou?r|pixel art|cartoon|anime)(?: style)?|(?:the )?same(?: thing| picture| one)?,? but\b|another (?:one|version|take|try)|one more(?: time)?|try (?:it )?again|again,? but\b|a (?:new |different )?(?:version|angle|take|style|colou?r)\b|(?:but|with|without)\s+\w+)`,
  "i",
);

// A change said as a statement: "the sky is too dark", "it needs more light".
const SHOULD =
  /\b(?:too (?:dark|light|bright|dull|busy|plain|small|big|large|much|many|few|empty|crowded|red|blue|green|yellow|orange|purple|pink|grey|gray|white|black)|should (?:be|have|look)|needs? (?:to be|to have|more|less|a|an|some)|could (?:be|use)|would look better|wish it)\b/i;
// Said once more, or in place of what is there.
const AGAIN = /\b(?:same|again|instead|another version|a new version|this time)\b/i;

// The picture itself, named: "it", "this one", "the picture", "the sky in it".
const NAMES_PICTURE = /\b(?:it|its|it's|this one|that one|the (?:picture|image|drawing|photo|painting|art|artwork|illustration|one))\b/i;
const CHANGE_CUE = /\b(?:darker|lighter|brighter|bigger|smaller|more|less|instead|again|version|same|different|but|without|at night|at sunset|style|colou?rs?|background|foreground|sky|light|lighting|too \w+)\b/i;

// Something other than the picture is being talked about.
const OTHER_THING =
  /\b(?:song|music|track|tune|melody|beat|lyrics|video|clip|film|movie|3d|document|doc|letter|e-?mail|essay|report|story|poem|list|plan|paragraph|sentence|message|reply|answer|summary|spreadsheet|slides?|deck|code|website|page)\b/i;
// Doing something with the file, not changing what is in it.
const FILE_ACTION =
  /\b(?:save|saved|library|folder|download|share|send|print|board|whiteboard|export|upload|rename|move on|delete (?:it|this|that|the (?:picture|image|file)))\b/i;
const PICTURE_WORD = /\b(?:picture|image|drawing|photo|painting|art|artwork|illustration|sky|background)\b/i;

/** "draw me a cat", "make a logo for my bakery", "a new picture of a boat": a new picture. */
export function isNewPictureAsk(message: string): boolean {
  const m = String(message || "").trim();
  if (!m) return false;
  // "the same house", "this picture again", "another version": not new, whatever the verb.
  if (/\b(?:same|again|another version|this picture|that picture|the picture|this one|that one)\b/i.test(m)) return false;
  const NOUN = "(?:image|picture|illustration|drawing|logo|poster|artwork|art|thumbnail|icon|banner|mockup|render|scene|photo|painting|sketch)";
  if (new RegExp(String.raw`\b(?:draw|paint|sketch|illustrate|render|generate|make|create|design|do)\s+(?:me\s+|us\s+)?(?:a|an|some)\s+(?:new\s+|different\s+|second\s+|whole new\s+)?(?:[\w'-]+\s+){0,3}?` + NOUN + String.raw`\b`, "i").test(m)) return true;
  // "draw me a duck", "paint a lighthouse": the subject follows the verb.
  if (/\b(?:draw|paint|sketch|illustrate)\s+(?:me\s+|us\s+)?(?:a|an|some)\s+\w+/i.test(m)) return true;
  if (/\b(?:a|another)\s+(?:new|different)\s+(?:picture|image|drawing|one)\s+(?:of|with|showing)\b/i.test(m)) return true;
  return false;
}

/** Does this message ask to change the picture in front of them? */
export function isPictureChange(message: string): boolean {
  const m = String(message || "").trim();
  if (!m || m.length > 400) return false;
  if (isNewPictureAsk(m)) return false;
  if (FILE_ACTION.test(m)) return false;
  // Another thing is the subject, and the picture is not named.
  if (OTHER_THING.test(m) && !PICTURE_WORD.test(m)) return false;
  const question = /\?\s*$/.test(m);
  // A request asked as a question is still a request ("can you make the sky darker?");
  // any other question is a question ("why is it so dark?").
  if (question && !new RegExp(LEAD + String.raw`(?:(?:can|could|would|will) you|how about|what about)\b`, "i").test(m)) return false;
  if (CHANGE_START.test(m)) return true;
  const words = m.split(/\s+/).filter(Boolean);
  if (words.length <= 8 && TWEAK.test(m)) return true;
  if (SHOULD.test(m) || AGAIN.test(m)) return true;
  if (NAMES_PICTURE.test(m) && CHANGE_CUE.test(m)) return true;
  if (/^\s*(?:how about|what about)\b/i.test(m)) return true;
  return false;
}

/** The instruction that goes to the picture maker along with the picture being changed. */
export function changePrompt(message: string): string {
  const change = String(message || "").trim().slice(0, 900);
  return (
    "Here is a picture we made together. Change it as asked, and keep everything else " +
    "— the subject, the layout, the style and the colours — as it is, unless the change says otherwise.\n\n" +
    `The change: ${change}`
  );
}

/** Data URL of a stored picture, small enough to send back to the picture maker. */
export function pictureDataUrl(body: Uint8Array | Buffer | null | undefined, contentType: string | null | undefined): string | null {
  if (!body || !body.byteLength) return null;
  const type = String(contentType || "").toLowerCase();
  if (!/^image\/(?:png|jpe?g|webp|gif)$/.test(type)) return null;
  // The picture maker takes inline images; past ~8 MB (≈11 MB as base64) the request
  // is likelier to be refused than helped. A bigger one is drawn without it.
  if (body.byteLength > 8 * 1024 * 1024) return null;
  return `data:${type};base64,${Buffer.from(body).toString("base64")}`;
}

function kindOf(t: MadeThing): string {
  const type = String(t.contentType || "").toLowerCase();
  const name = String(t.filename || "").toLowerCase();
  if (type.startsWith("image/")) return name.startsWith("art-") ? "A picture BeeZilla made" : "A picture";
  if (type.startsWith("audio/")) return name.startsWith("music-") ? "A song BeeZilla made" : "Audio";
  if (type.startsWith("video/")) return "A video";
  if (/gltf|glb|model\//.test(type) || /\.(glb|gltf|obj|fbx|usdz)$/.test(name)) return "A 3D model";
  if (type === "application/pdf" || /\.(pdf|docx?|md|txt)$/.test(name)) return "A document";
  return "A file";
}

function ago(at: string | Date, now: number): string {
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return "";
  const min = Math.floor((now - t) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/**
 * What this conversation made, for the system prompt: oldest first, numbered, with
 * the words that asked for each. Empty when nothing was made.
 */
export function madeThingsSection(things: MadeThing[], now = Date.now()): string {
  const list = (things || []).filter((t) => t && t.filename).slice(-12);
  if (!list.length) return "";
  const lines = list.map((t, i) => {
    const brief = String(t.brief || "").replace(/\s+/g, " ").trim().slice(0, 160);
    const when = ago(t.createdAt, now);
    return `${i + 1}. ${kindOf(t)}${brief ? ` — asked as: "${brief}"` : ""}${when ? ` (${when})` : ""}`;
  });
  const newest = list[list.length - 1]!;
  const newestIsPicture = String(newest.contentType || "").toLowerCase().startsWith("image/");
  return (
    "\n\nMADE IN THIS CONVERSATION (oldest first). The person can mean any of these by \"it\", " +
    "\"the picture\", \"the first song\" and so on; they are all saved in their Library:\n" +
    lines.join("\n") +
    (newestIsPicture
      ? "\nWhen they ask for a change to the newest picture, the picture maker draws the new version FROM it; " +
        "only say a change was made when this turn says a picture was rendered."
      : "") +
    "\nNever name a file."
  );
}

/**
 * Pictures the person joined with a line into one of BeeZilla's steps on the Idea Board
 * (owner, 2026-11-20: connectors that mean something, "within our own framework").
 * The board's summary (whiteboard.js `compile`) names them on its first line,
 * "[[board-pictures: 12,40]]". That line is taken off here, before the board's text
 * reaches the model, and the ids become the picture maker's references. They are only
 * ids: the caller loads them with the person's own user id, so a made-up line can't
 * reach anyone else's picture.
 */
export const BOARD_PICTURES_MAX = 4;
export function takeBoardPictures(text: string | null | undefined): { text: string; ids: number[] } {
  const ids: number[] = [];
  const rest = String(text ?? "").replace(/^\s*\[\[board-pictures:\s*([0-9,\s]{1,160})\]\][^\S\n]*(?:\n|$)/, (_m, list: string) => {
    for (const part of list.split(",")) {
      const n = Number(part.trim());
      if (Number.isSafeInteger(n) && n > 0 && !ids.includes(n) && ids.length < BOARD_PICTURES_MAX) ids.push(n);
    }
    return "";
  });
  return { text: rest, ids };
}

/** A new picture drawn from the pictures connected on the board. */
export function boardReferencePrompt(message: string, count: number): string {
  const ask = String(message || "").replace(/\s+/g, " ").trim().slice(0, 900);
  return (
    (count === 1
      ? "Use the attached picture from the person's board as the reference."
      : `Use the ${count} attached pictures from the person's board as references.`) +
    " Keep what they show (the subject, the style and the colours) unless the request says otherwise.\n\nThe request: " + ask
  );
}

/**
 * Every picture of theirs on the Idea Board, joined or not, named on a line of the
 * board's summary (whiteboard.js `seenLine`): "[[board-seen: 12:Ark Titan concept;
 * 40:made here]]". It sits first, or second after the pictures line, and is taken off
 * here before the summary reaches the model; BeeZilla looks at those pictures
 * (vision.ts). Ids only reach the person's own files: the caller loads them with the
 * person's own user id. At most eight; a name is the board's own words, cut short.
 */
export const BOARD_SEEN_MAX = 8;
export function takeBoardSeen(text: string | null | undefined): { text: string; seen: Array<{ id: number; label: string }> } {
  const seen: Array<{ id: number; label: string }> = [];
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < Math.min(2, lines.length); i++) {
    const m = /^\s*\[\[board-seen:\s*([^\]\n]{1,1200})\]\][^\S\n]*$/.exec(lines[i]!);
    if (!m) continue;
    for (const part of m[1]!.split(";")) {
      const at = part.indexOf(":");
      const idText = (at >= 0 ? part.slice(0, at) : part).trim();
      if (!/^\d{1,15}$/.test(idText)) continue;
      const id = Number(idText);
      if (!Number.isSafeInteger(id) || id <= 0 || seen.some((s) => s.id === id) || seen.length >= BOARD_SEEN_MAX) continue;
      // eslint-disable-next-line no-control-regex
      const label = (at >= 0 ? part.slice(at + 1) : "").replace(/[\u0000-\u001f\u007f-\u009f[\]{}<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
      seen.push({ id, label: label === "made here" ? "" : label });
    }
    lines.splice(i, 1);
    break;
  }
  return { text: lines.join("\n"), seen };
}
