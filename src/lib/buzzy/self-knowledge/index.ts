/**
 * BeeZilla's answers about itself (roadmap phase 6: a verified answer base,
 * "do not fabricate capabilities, active models or deployment status").
 *
 * answers.json holds 50 questions an owner asks about BeeZilla, each answered in
 * plain words and tied to the code that makes it true: every source names a file
 * and an exact phrase in it, and scripts/test-self-knowledge.ts fails when a
 * phrase disappears, so an answer cannot outlive the behaviour it describes.
 *
 * When a chat message is a question about BeeZilla itself, the chat loop adds the
 * closest answers to the system prompt as verified facts, so the reply comes from
 * the product's real behaviour rather than the model's guess. The data is local:
 * nothing leaves BeeZilla to use it, so it applies in Lockdown too.
 */
import answers from "./answers.json";

export interface SelfAnswer {
  id: string;
  q: string;
  a: string;
  sources: { file: string; symbol: string }[];
  surfaces: ("website" | "desktop")[];
  limits?: string;
}

export const SELF_ANSWERS: readonly SelfAnswer[] = answers as SelfAnswer[];

// Unambiguous product words: a question that uses one is about BeeZilla.
const STRONG = /\b(bee ?zilla|buzzy|lockdown|advocate|privacy modes?|open mode|honey drops?|white ?board|inspiration( wall)?|talk bar|do it button|speak replies|attach a paper|work mode|chat mode|chats left|public link|share link|invitation link|desktop app|capabilities page|free plan|starter plan|pro plan|my plan|my library|learn a recipe)\b/;
// Words BeeZilla shares with everyday life ("recipe", "history"): only a short
// "what is a …?" question about one of them is taken as a question about BeeZilla.
const DEFINE = /^(what|what's|whats)\s+(is|are)\s+(a |an |the )?(recipes?|library|memory|history|experts?|sketch|studio|whiteboard|honey drops?|inspiration|capabilities)\s*\??$/;
// "How do I share / invite / download …?" — doing something in BeeZilla.
const HOW_IN_APP = /\b(how (do|can|would) i|can i|where (do|can) i|is there a way to)\s+(share|invite|export|download|accept|attach|upload|turn (it |the link )?off|stop sharing|rename|reopen|find my|save|delete|change (my )?(plan|privacy))\b/;
// "Can you make music?" — asking what BeeZilla can do, not asking it to do a job.
const CAN_YOU = /\b(can|could|do|does|will|would)\s+(you|beezilla|it)\s+(\w+\s+){0,2}?(make|create|generate|do|read|send|search|browse|remember|speak|talk|draw|look things up|look up|open|edit|email|log in|fill( in)?|use|work|see|keep|save|share|play)\b/;
const ABOUT_YOU = /\b(what can you do|what do you do|who are you|what are you|are you able to|is it possible to|what are your (limits|features|capabilities))\b/;
// A concrete request phrased politely ("can you make me a song about rain?").
// "About my business" / "about me" stays a question about what BeeZilla does.
const CONCRETE = /\b(about (?!my\b|me\b|myself\b|our\b|us\b)|for me|me a|me an|for my|called|titled|with the words)/;

const QUESTION = /\?\s*$|^(how|what|what's|whats|where|which|why|who|can|could|do|does|is|are|will|would)\b/;

function normal(message: string): string {
  return String(message || "").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
}

export function isAboutBeeZilla(message: string): boolean {
  const m = normal(message);
  if (!m || m.length > 300 || !QUESTION.test(m)) return false;
  if (/\brecipe for\b/.test(m) && !/\bbee ?zilla\b/.test(m)) return false; // cooking, not BeeZilla recipes
  if (STRONG.test(m) || DEFINE.test(m) || HOW_IN_APP.test(m) || ABOUT_YOU.test(m)) return true;
  if (CAN_YOU.test(m) && !CONCRETE.test(m) && m.length <= 90) return true;
  return false;
}

const STOP = new Set(("a an and are as at be by can could do does for from get got have how i if in into is it its me my " +
  "of on or so that the their there these this to too up us was we what whats when where which who why will with " +
  "would you your yours beezilla buzzy").split(" "));

function tokens(text: string): string[] {
  return normal(text)
    .replace(/[^a-z0-9& ]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

const INDEX = SELF_ANSWERS.map((entry) => ({
  entry,
  q: new Set(tokens(entry.q)),
  a: new Set(tokens(entry.a + " " + (entry.limits ?? ""))),
}));

/** The closest answers to a message: question words count three times answer words. */
export function relevantAnswers(message: string, k = 5): SelfAnswer[] {
  const words = Array.from(new Set(tokens(message)));
  if (!words.length) return [];
  return INDEX
    .map((row, i) => {
      let score = 0;
      for (const w of words) {
        if (row.q.has(w)) score += 3;
        else if (row.a.has(w)) score += 1;
      }
      return { entry: row.entry, score, i };
    })
    .filter((r) => r.score > 0)
    .sort((x, y) => y.score - x.score || x.i - y.i)
    .slice(0, Math.max(0, k))
    .map((r) => r.entry);
}

const NOTE_LIMIT = 2500;

/**
 * The system note for a question about BeeZilla, or null for anything else.
 * It tells the model to answer from these facts and to say it is not sure when
 * they do not cover the question — never to invent a feature, plan or setting.
 */
export function selfKnowledgeNote(message: string): string | null {
  if (!isAboutBeeZilla(message)) return null;
  let note =
    "VERIFIED FACTS ABOUT BEEZILLA — the owner is asking about BeeZilla itself. Answer from these facts in plain words. " +
    "If they do not cover the question, say you are not sure rather than guessing, and never claim a feature, plan, " +
    "model or setting that is not stated here.";
  const found = relevantAnswers(message, 5);
  if (!found.length) return note + "\n(No verified fact matches this question.)";
  for (const f of found) {
    const line = `\nQ: ${f.q}\nA: ${f.a}` + (f.limits ? ` (Limit: ${f.limits})` : "");
    if (note.length + line.length > NOTE_LIMIT) break;
    note += line;
  }
  return note;
}
