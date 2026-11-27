/**
 * What a 3D model is made from: their picture, two to four views of one thing, or words.
 *
 * Testers, 2026-11-24: "I want you to go ahead and take a look at this helicopter and turn
 * it into a 3D model for me" — and concept art put first in a string of cards — came back
 * as unrelated objects, because the sentence itself went to Text to 3D and the picture
 * went nowhere. "We don't need the three D tab back. We just need it to be able to turn an
 * actual image into that thing."
 *
 * A photo goes to the 3D maker only when it is plain which one (reviews, 2026-11-25: every
 * round of word matching found a new phrasing that sent the wrong photo). Plain means: the
 * one they point at or hold; the one(s) added to this message; the conversation's only
 * picture when the words say "this/my photo"; the one picture joined into the 3D step; or
 * the one picture whose name or contents say the thing asked for (the thing itself —
 * "car", not only "red"). Several pictures, as views of one thing, only when the words ask
 * for several views and the set is plain (the pictures added together, or the ones joined
 * into the step); "not both", "only the first" always win. When it isn't plain — no picture
 * fits the words that name one, more than one fits, or the one in play shows something
 * else — nothing is started and the reply asks which picture: never a guess, and never a
 * quiet switch to words or to another picture. Words with no picture named or in play
 * ("a 3D model of a dragon") are words: rewritten into the one-object description Text to
 * 3D needs, with the board's notes in mind, never sent as the sentence they typed.
 */
import { modelPurpose, type ModelPlan } from "./models3d";
import type { PictureLook } from "./vision";

export interface PictureChoice {
  ids: number[];
  why: "pointed" | "attached" | "connected" | "named" | "only one" | "in the conversation" | "made here";
  /** What the picture is called on the board, for the reply ("your picture “Ark Titan”"). */
  label: string;
}

/** Not plain which picture: nothing is started, and the reply asks this question. */
export interface PictureAsk {
  ask: true;
  question: string;
  candidates: Array<{ id: number; name: string }>;
}

// Words that only ask for a 3D model, and pointing words: what is left is the subject.
const ASK_WORDS =
  /\b(?:please|pls|can|could|would|will|you|i|i'?d|me|my|us|we|want|need|like|go|ahead|and|to|a|an|the|of|for|from|into|in|as|it|this|that|these|those|one|thing|there|here|now|just|make|made|making|create|creating|build|building|turn|turning|convert|converting|generate|generating|model|models|modelling|modeling|3d|three|d|version|out|take|look|looking|at|in front|front|picture|pictures|image|images|photo|photos|drawing|concept|art|artwork|sketch|render|give|get|do|have|on|board|whiteboard|idea|card|ok|okay|hey|beezilla|bee|zilla)\b/gi;

// Words that only say which picture ("my uploaded photo", "the one I sent"): not a subject.
const WHICH_WORDS = /\b(?:uploaded|upload|attached|attachment|added|sent|dropped|pasted|shared|provided|gave|given|mine|own|above|below|earlier|last|latest|previous|new|just|screenshot|pic|png|jpe?g|webp|file)\b/gi;
// Words that describe a thing — its colour, material, size, style, or the kind of model
// ("low-poly", "game ready") — never which thing it is: "the red car" is a car.
const LOOK_WORDS = new Set(("red orange yellow green blue purple pink black white grey gray gold golden silver bronze copper " +
  "brown beige tan teal cyan magenta violet maroon navy turquoise wood wooden stone marble glass crystal metal metallic chrome " +
  "steel iron plastic rubber leather fabric paper clay ceramic concrete brick ice neon camo camouflage rusty matte glossy shiny " +
  "bright dark light pale desert arctic woodland small big large tiny huge giant mini little low poly lowpoly high detail " +
  "detailed realistic photorealistic stylised stylized cartoon cartoony toon anime pixel voxel printable print printing game " +
  "ready rigged rig textured texture clean quad mesh version style look looks like same exactly copy cute").split(" "));
// Words about how many pictures or which of them — never the thing.
// Little words that join a sentence, never the thing ("but in gold", "with a hat too").
const FILLER_WORDS = new Set("but with also too very really maybe some any more less way than then yet still even quite".split(" "));
// (A direction on its own — "side", "top", "back" — can be the thing: "a side table", "a
// table top"; only views asked for in so many words are views, asksForViews.)
const COUNT_WORDS = new Set(("both all each every several multiple single only not except without other others rest first " +
  "second third fourth last 1st 2nd 3rd 4th one two three four five six view views angle angles sides turnaround turnarounds " +
  "orthographic ortho orthos multiview multi").split(" "));

/** The words of the request that name a subject ("helicopter", "red dragon"), lower case. */
export function subjectWords(message: string): string[] {
  const rest = String(message || "").toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' -]+/g, " ").replace(ASK_WORDS, " ").replace(WHICH_WORDS, " ");
  return rest.split(/\s+/).map((w) => w.replace(/^'+|'+$/g, "")).filter((w) => w.length > 2);
}

/** "my uploaded helicopter photo", "the picture I sent", "from my drawing": one of theirs. */
export function refersToTheirPicture(message: string): boolean {
  const m = String(message || "").toLowerCase();
  return /\b(?:uploaded|attached|i (?:just )?(?:sent|added|uploaded|attached|dropped|pasted|shared))\b/.test(m) ||
    /\b(?:my|our|this|that|the)\s+(?:[a-z0-9'-]+\s+){0,3}(?:picture|image|photo|pic|drawing|sketch|render|concept(?: art)?|artwork|screenshot|upload)s?\b/.test(m);
}

/** "make it 3D", "turn this into a 3D model": no subject of its own. */
export function noSubjectOfItsOwn(message: string): boolean {
  return subjectWords(message).length === 0;
}

/** Points at a picture or at "it/this" ("make this 3D", "the concept art as a 3D model"). */
export function pointsAtAPicture(message: string): boolean {
  return /\b(?:this|that|it|these|those|the (?:picture|image|photo|drawing|concept(?: art)?|art(?:work)?|sketch|render|one (?:on|in) (?:the|my) board))\b/i.test(String(message || ""));
}

/**
 * The words themselves ask for one model from several pictures or views ("from these
 * views", "the front and side views", "from both sides", "all four of these photos", "a
 * turnaround") — never a single word that also means something else ("a table top", "the
 * back of the chair").
 */
const VIEW_ASKS = [
  /\b(?:views|angles|multi[\s-]?views?|turn[\s-]?arounds?|orthographics?|orthos)\b/g,
  /\b(?:front|side|back|rear|top|left|right)\s*(?:,|and|&|\/)\s*(?:the\s+)?(?:front|side|back|rear|top|left|right)\b/g,
  /\b(?:both|all|every|each)(?:\s+(?:of|the|these|those|my|two|three|four|five|six))*\s+(?:sides|angles|views|pictures|photos|images|shots)\b/g,
  /\b(?:these|those)\s+(?:two|three|four|five|six)\s+(?:sides|angles|views|pictures|photos|images|shots)\b/g,
];
export function asksForViews(message: string): boolean {
  const m = String(message || "").toLowerCase();
  return VIEW_ASKS.some((re) => { re.lastIndex = 0; return re.test(m); });
}
// The message without its words asking for views: they say how many pictures, not which thing.
function withoutViewAsks(message: string): string {
  let m = String(message || "").toLowerCase();
  for (const re of VIEW_ASKS) { re.lastIndex = 0; m = m.replace(re, " "); }
  return m;
}

/** Two or more of the pictures are named as views of one thing ("front", "side view"). */
export function labelsSayViews(labels: string[]): boolean {
  return labels.filter((l) => /\b(?:views?|front|back|rear|side|left|right|top|angle|turn[\s-]?around|ortho(?:graphic)?)\b/i.test(String(l || ""))).length >= 2;
}

/** Front, side and back views of one thing: asked for in the words, or named so. */
export function wantsViews(message: string, labels: string[]): boolean {
  return asksForViews(message) || labelsSayViews(labels);
}

/** "not both", "only the first", "except the beach": a limit, which always wins over views. */
export function limitsPictures(message: string): boolean {
  return /\bnot\s+(?:both|all|these|those|the\s+(?:other|others|rest|second|first|last|two|three|four))\b|\b(?:only|just)\s+(?:the\s+)?(?:first|second|third|fourth|last|1st|2nd|3rd|4th|one)\b|\b(?:first|second|third|fourth|last|1st|2nd|3rd|4th)\s+(?:one|photo|picture|image|pic)\s+only\b|\bexcept\b|\bwithout\s+the\b|\bsingle\s+(?:photo|picture|image)\b|\bjust\s+(?:this|that)\s+(?:one|photo|picture|image)\b/i.test(String(message || ""));
}

/**
 * "the first photo", "the last one": which of a set, counted from the first added (-1: the
 * last). `not` is true when that one is excluded ("not the first photo", "except the last one").
 */
export function pictureOrdinal(message: string): { at: number; not: boolean } | null {
  const text = String(message || "");
  const m = /\b(first|second|third|fourth|last|1st|2nd|3rd|4th)\s+(?:one|photo|picture|image|pic|upload|attachment|view)\b/i.exec(text);
  if (!m) return null;
  const w = m[1]!.toLowerCase();
  const at = w === "last" ? -1 : ({ first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3 } as Record<string, number>)[w];
  if (at === undefined) return null;
  const before = text.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
  return { at, not: /\b(?:not|except|without|but not|other than|instead of)\s+(?:the\s+|my\s+)?$/.test(before) };
}

/** They chose words over a picture ("from my words", "no photo", "just the description"). */
export function wantsWordsOnly(message: string): boolean {
  return /\bfrom\s+(?:my|the|these|those|your)?\s*(?:own\s+)?(?:words|description|text|prompt)\b|\b(?:without|no)\s+(?:a\s+|the\s+|any\s+)?(?:picture|photo|image|reference)s?\b|\b(?:words|text|description)\s+only\b|\bjust\s+(?:from\s+)?(?:the\s+|my\s+)?(?:words|description|text)\b/i.test(String(message || ""));
}

/**
 * The thing the words name ("helicopter", "table leg") and how it should look ("red",
 * "wooden", "low-poly"). A look word that is the thing itself ("a crystal", "a 3D model of
 * a gold") counts as the thing.
 */
export function thingWords(message: string): { thing: string[]; looks: string[] } {
  const stem = (w: string) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
  // Views asked for ("the front and side views") say how many pictures, not what.
  const tokens = subjectWords(withoutViewAsks(message)).flatMap((w) => w.split("-")).map((w) => w.replace(/'s$/, "")).filter((w) => w.length > 2);
  const kept = tokens.filter((w) => !COUNT_WORDS.has(w) && !FILLER_WORDS.has(w));
  const thing: string[] = [];
  const looks: string[] = [];
  kept.forEach((w, i) => {
    const asThing = i === kept.length - 1 && LOOK_WORDS.has(w) &&
      new RegExp(`\\b(?:a|an)\\s+${w}\\b|\\bof\\s+(?:a|an)\\s+${w}\\b`, "i").test(String(message || ""));
    (LOOK_WORDS.has(w) && !asThing ? looks : thing).push(stem(w));
  });
  return { thing: [...new Set(thing)], looks: [...new Set(looks)] };
}

/**
 * Which picture(s) the model is made from; or a question when that isn't plain; or null for
 * words. `seen` is what BeeZilla looked at this turn (vision.ts): what each picture shows,
 * so "the helicopter" can find the picture of one even when its card is "IMG_2041.png".
 */
export function choosePictures(input: {
  message: string;
  pointed: number | null;
  attached: number[];
  connected: number[];
  seen: PictureLook[];
  onBoard: number[];
  /** Pictures added earlier in this conversation (Talk), newest first. */
  inChat?: number[];
  newestMade: number | null;
}): PictureChoice | PictureAsk | null {
  const { message } = input;
  const uniq = (ids: Array<number | null | undefined>) =>
    [...new Set(ids.filter((n): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0))];
  // The same file added twice is one picture (a Library file has one id).
  const attached = uniq(input.attached);
  const connected = uniq(input.connected);
  const inChat = uniq(input.inChat ?? []);
  const conversation = uniq([...inChat, input.newestMade]);
  const look = (id: number) => input.seen.find((s) => s.id === id);
  const labelOf = (id: number) => look(id)?.label ?? "";
  const textOf = (id: number) => { const s = look(id); return s ? `${s.label} ${s.note}`.toLowerCase() : ""; };
  const nameOf = (id: number) => {
    const s = look(id);
    if (s?.label) return s.label;
    const words = (s?.note ?? "").replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ").replace(/[.,;:]+$/, "");
    return words || (inChat.includes(id) ? "the picture added earlier" : id === input.newestMade ? "the picture made here" : "a picture");
  };
  const { thing, looks } = thingWords(message);
  const says = (id: number, words: string[]) => {
    const text = textOf(id);
    return Boolean(text) && words.every((w) => new RegExp(`\\b${w.replace(/[^a-z0-9]/g, "")}(?:s|es)?\\b`, "i").test(text));
  };
  // Known to show what the words name — the thing itself.
  const shows = (id: number) => thing.length > 0 && says(id, thing);
  // Not known to show something else (a picture not looked at yet can't be told apart) —
  // for a picture they point at, added, or that is in the conversation. A picture joined on
  // the board may feed any step: for a thing named, it must be known to show it.
  const fits = (id: number) =>
    !thing.length || (!textOf(id) ? !(input.connected.includes(id) && id !== input.pointed && !attached.includes(id) && !conversation.includes(id)) : says(id, thing));
  // Of several that show the thing, the looks asked for ("red") tell them apart.
  const narrow = (ids: number[]) => {
    let c = ids.filter(shows);
    if (c.length > 1 && looks.length) { const d = c.filter((id) => says(id, looks)); if (d.length) c = d; }
    return c;
  };
  const one = (id: number, why: PictureChoice["why"]): PictureChoice => ({ ids: [id], why, label: labelOf(id) });
  const quoted = (ids: number[]) => {
    const names = ids.slice(0, 4).map((id) => `“${nameOf(id)}”`);
    return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
  };
  const askWhich = (ids: number[], lead?: string): PictureAsk => {
    const named = ids.slice(0, 4);
    // The answers suggested are whole requests that come back here and resolve: a card's exact
    // name, or words only.
    const question = (lead ? lead + " " : "") + (named.length
      ? `Which picture should the 3D model be made from: ${quoted(named)}? Say, for example, “make the 3D model from ${nameOf(named[0]!)}” — or “make the 3D model from my words”.`
      : "Which picture should the 3D model be made from? Point at it, add it to your message, or say “make the 3D model from my words”.");
    return { ask: true, question, candidates: named.map((id) => ({ id, name: nameOf(id) })) };
  };
  const thingName = thing.join(" ");
  const ref = pointsAtAPicture(message) || refersToTheirPicture(message);
  const limited = limitsPictures(message);

  // 0. Words only, when they say so ("make the 3D model from my words", "no photo").
  if (wantsWordsOnly(message)) return null;
  // 0b. A picture named by its card's own name ("make the 3D model from IMG_0003.jpg",
  // "…from Helicopter concept"): that one. Only names that can't be ordinary words (a file
  // name, a number, two words or more); a single word goes by what the pictures show (6).
  const allKnown = uniq([input.pointed, ...attached, ...connected, ...conversation, ...input.onBoard, ...input.seen.map((s) => s.id)]);
  const lower = message.toLowerCase();
  const byName = allKnown.filter((id) => {
    const l = labelOf(id).toLowerCase().trim();
    if (l.length < 3 || !(/[\d_.]/.test(l) || /\s/.test(l))) return false;
    const base = l.replace(/\.(?:png|jpe?g|webp|gif)$/i, "");
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9])(?:${esc(l)}|${esc(base)})(?:[^a-z0-9]|$)`, "i").test(lower);
  });
  if (byName.length === 1) return one(byName[0]!, "named");
  // 1. "the first photo", "the second one I uploaded", "not the first photo": counted in the
  // set the words name — the pictures added, or the ones joined on the board — and only
  // when that set is plain. An excluded one is never the one sent.
  const ordinal = pictureOrdinal(message);
  if (ordinal !== null) {
    const uploads = attached.length ? attached : [...inChat].reverse();
    const saysUploads = /\b(?:uploaded|attached|added|sent|dropped|pasted|my\s+(?:photo|picture|image|pic|upload)s?)\b/i.test(message);
    const saysBoard = /\b(?:on (?:the|my) (?:idea )?board|joined|linked|wired|connected)\b/i.test(message);
    const sets = [uploads, connected].filter((x) => x.length);
    const set = saysUploads ? uploads : saysBoard ? connected : sets.length === 1 ? sets[0]! : [];
    if (!set.length) return askWhich(uniq([...uploads, ...connected]));
    const index = ordinal.at === -1 ? set.length - 1 : ordinal.at;
    const why: PictureChoice["why"] = set === connected ? "connected" : attached.length ? "attached" : "in the conversation";
    if (ordinal.not) {
      const left = set.filter((_, i) => i !== index);
      if (left.length === 1 && fits(left[0]!)) return one(left[0]!, why);
      return askWhich(left.length ? left : set);
    }
    const id = set[index];
    if (id === undefined || !fits(id)) return askWhich(set);
    return one(id, why);
  }
  // 2. Several views of one thing: only when the words ask for them, and the set is plain —
  // the pictures added together, or the ones joined into the step — and holds one thing.
  if (asksForViews(message) && !limited) {
    const saysAdded = /\b(?:attached|uploaded|added|sent|dropped|pasted)\b/i.test(message);
    const saysBoard = /\b(?:on (?:the|my) (?:idea )?board|joined|linked|wired|connected)\b/i.test(message);
    const set = saysAdded ? attached : saysBoard ? connected : attached.length >= 2 ? attached : connected;
    const count = /\b(?:these|those|the|all|both)\s+(two|three|four|2|3|4)\b/i.exec(message)?.[1]?.toLowerCase();
    const wanted = /\bboth\b/i.test(message) ? 2 : count ? ({ two: 2, three: 3, four: 4, "2": 2, "3": 3, "4": 4 } as Record<string, number>)[count] ?? 0 : 0;
    if (set.length < 2 || set.length > 4 || (wanted && wanted !== set.length) || !set.every(fits)) {
      return askWhich(uniq([...attached, ...connected, ...conversation]),
        "To make one model from several views, the pictures have to be plain: add them to one message together, or join them into the 3D step on your board.");
    }
    const front = set.find((id) => /\bfront\b/.test(textOf(id)));
    const ordered = front === undefined ? set : [front, ...set.filter((id) => id !== front)];
    return { ids: ordered, why: saysAdded || (!saysBoard && attached.length >= 2) ? "attached" : "connected", label: labelOf(ordered[0]!) };
  }
  // 3. What they point at or hold.
  if (input.pointed !== null) {
    if (fits(input.pointed)) return one(input.pointed, "pointed");
    return askWhich([input.pointed], `The picture you're pointing at doesn't look like ${thingName ? `a ${thingName}` : "what you asked for"}.`);
  }
  // 4. What they added to this message.
  if (attached.length === 1) {
    if (fits(attached[0]!)) return one(attached[0]!, "attached");
    return askWhich(attached, `The picture you added doesn't look like ${thingName ? `a ${thingName}` : "what you asked for"}.`);
  }
  if (attached.length > 1) {
    const c = thing.length ? narrow(attached) : [];
    if (c.length === 1) return one(c[0]!, "attached");
    return askWhich(c.length > 1 ? c : attached);
  }
  // 5. "this/my photo" — the conversation's pictures — and the pictures joined into the step.
  const inPlay = uniq([...(ref ? conversation : []), ...connected]);
  const whyOf = (id: number): PictureChoice["why"] =>
    connected.includes(id) ? "connected" : inChat.includes(id) ? "in the conversation" : "made here";
  if (inPlay.length === 1) {
    if (fits(inPlay[0]!)) return one(inPlay[0]!, whyOf(inPlay[0]!));
  } else if (inPlay.length > 1) {
    if (!thing.length) return askWhich(inPlay);
    const c = narrow(inPlay);
    if (c.length === 1) return one(c[0]!, whyOf(c[0]!));
    if (c.length > 1) return askWhich(c);
  }
  // 6. A thing named: the one picture anywhere that shows it.
  if (thing.length) {
    const everyOne = uniq([...input.seen.map((s) => s.id), ...connected, ...conversation, ...input.onBoard]);
    const c = narrow(everyOne);
    if (c.length === 1) return one(c[0]!, "named");
    if (c.length > 1) return askWhich(c);
    // None shows it: words — unless the words name a photo, or a picture of theirs from the
    // conversation is in play: then which picture is meant isn't plain. (Pictures joined on
    // the board may feed another step: they alone don't make it a question.)
    if (ref || inPlay.some((id) => !connected.includes(id))) return askWhich(inPlay.length ? inPlay : everyOne, `None of your pictures looks like ${thingName ? `a ${thingName}` : "that"}.`);
    return null;
  }
  // 7. Nothing named, and "this/it" with nothing in play: which picture isn't plain.
  if (ref) return askWhich(uniq([...input.onBoard, ...input.seen.map((s) => s.id)]));
  return null;
}

/** A rough sketch is better cleaned up; anything else keeps its exact look. */
export function keepsLook(message: string, notes: string[]): boolean {
  if (/\b(?:clean (?:it )?up|make it (?:look )?(?:better|nicer|realistic|real)|realistic|photo[\s-]?real)\b/i.test(message)) return false;
  return !notes.some((n) => /\b(?:rough sketch|pencil sketch|line drawing|doodle|scribble|hand[\s-]?drawn sketch)\b/i.test(n));
}

/** A look they asked for that differs from the picture ("but in desert camo", "make it gold"). */
export function styleAsk(message: string): string | undefined {
  const m = String(message || "").replace(/\s+/g, " ").trim();
  const after = /\b(?:but|except|only)\b\s+(.{3,300})$/i.exec(m)?.[1];
  if (after) return after.replace(/[.!?]+$/, "");
  const look = /\b(?:in|with|made of|painted|coloured|colored)\s+((?:(?:bright|dark|light|matte|glossy|shiny|rusty|desert|arctic|woodland|metallic|chrome)\s+)?(?:red|orange|yellow|green|blue|purple|pink|black|white|grey|gray|gold|golden|silver|bronze|copper|camo|camouflage|wood|wooden|stone|marble|glass|crystal|neon)(?:\s+\w+){0,4})/i.exec(m)?.[1];
  return look ? look.replace(/[.!?]+$/, "") : undefined;
}

/** The instruction for writing the words Text to 3D gets (one object, no scene). */
export function promptWriterInstruction(): string {
  return (
    "Write the description a text-to-3D generator needs for ONE object, from what the person asked and the notes from their board. " +
    "Say what it is; its overall shape and proportions; its main parts and how they join; its materials and colours; and its style — " +
    "the style they asked for or their board shows (stylised, cartoon, low-poly, sci-fi concept…); say realistic only if they did. " +
    "No scene, background, ground, lighting, camera or render words, no text or logos, no 'a 3D model of'. " +
    "At most 600 characters. Answer with the description only."
  );
}

/** Words → the one-object description (no model at hand: their words, minus the asking). */
export function fallbackPrompt(message: string): string {
  const m = String(message || "")
    .replace(/\b(?:please|can you|could you|would you|i(?:'d| would)? (?:like|want|need)(?: you)? to|go ahead and|make (?:me |us )?|create|build|generate|turn|convert)\b/gi, " ")
    .replace(/\b(?:a |an )?3d (?:model|version|print)(?: of)?\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return m.slice(0, 600) || String(message || "").slice(0, 600);
}

/**
 * The plan for this turn's model. `load` reads one of the person's pictures as a data URI
 * (their own user id, in the caller); `write` asks a model to write the description for
 * words. Both are passed in, so the choice is tested without a database or a model.
 */
export async function planModel3d(input: {
  message: string;
  pointed: number | null;
  attached: number[];
  connected: number[];
  seen: PictureLook[];
  onBoard: number[];
  inChat?: number[];
  newestMade: number | null;
  boardText: string;
  load: (id: number) => Promise<string | null>;
  write?: (instruction: string, ask: string) => Promise<string | null>;
}): Promise<{ plan: ModelPlan; from: PictureChoice | null } | { error: string; code: string; candidates?: string[] }> {
  const purpose = modelPurpose(input.message);
  const pose = /\b(?:rig(?:ged|ging)?|animat(?:e|ed|ion)|a[\s-]?pose|t[\s-]?pose)\b/i.test(input.message)
    ? (/\bt[\s-]?pose\b/i.test(input.message) ? "t-pose" : "a-pose")
    : undefined;
  const choice = choosePictures(input);
  // Not plain which picture: nothing is started; the reply asks.
  if (choice && "ask" in choice) return { code: "which_picture", error: choice.question, candidates: choice.candidates.map((c) => c.name) };
  if (choice) {
    // Each picture, with its id: what is recorded is what was sent (the first of them is
    // what a repaint is painted from). All of them, or none: a view that can't be sent is
    // never quietly left out of the set they chose.
    const sent: Array<{ id: number; url: string }> = [];
    for (const id of choice.ids) {
      const url = await input.load(id);
      if (url) sent.push({ id, url });
    }
    if (sent.length === choice.ids.length) {
      const ids = sent.map((x) => x.id);
      const notes = ids.map((id) => input.seen.find((s) => s.id === id)?.note).filter((n): n is string => Boolean(n));
      const label = ids[0] === choice.ids[0] ? choice.label : (input.seen.find((s) => s.id === ids[0])?.label ?? "");
      return {
        plan: {
          kind: sent.length >= 2 ? "multi" : "image",
          prompt: (label ? `${label}: ` : "") + (notes[0] ?? input.message).slice(0, 700),
          images: sent.map((x) => x.url),
          purpose,
          keepLook: keepsLook(input.message, notes),
          texturePrompt: styleAsk(input.message),
          ...(pose ? { pose } : {}),
        },
        from: { ...choice, ids, label },
      };
    }
    // The picture they meant can't be sent (too big, not a JPG/PNG/WebP): say so. Never make
    // an unrelated model from their words instead, and spend credits on it.
    return {
      code: "picture_unreadable",
      error: `the picture${choice.label ? ` “${choice.label}”` : ""} can't be sent to the 3D maker (it takes JPG, PNG or WebP pictures up to 20 MB)`,
    };
  }
  const ask = `What they asked: ${String(input.message).slice(0, 900)}` + (input.boardText ? `\n\nNotes from their board:\n${input.boardText.slice(0, 1800)}` : "");
  let prompt: string | null = null;
  if (input.write) {
    try { prompt = await input.write(promptWriterInstruction(), ask); } catch { prompt = null; }
  }
  const words = String(prompt || "").replace(/\s+/g, " ").replace(/^["“]|["”]$/g, "").trim().slice(0, 800) || fallbackPrompt(input.message);
  return { plan: { kind: "text", prompt: words, images: [], purpose, keepLook: true, texturePrompt: styleAsk(input.message), ...(pose ? { pose } : {}) }, from: null };
}
