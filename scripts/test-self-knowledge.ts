/**
 * BeeZilla's answers about itself (src/lib/buzzy/self-knowledge).
 *
 * The anti-fabrication check: every answer cites files and exact phrases in them,
 * and this test fails the moment a cited phrase disappears from the code — an
 * answer cannot outlive the behaviour it describes. Also pins which messages count
 * as questions about BeeZilla, which answers they find, and the note's size.
 *
 * Run: npx tsx scripts/test-self-knowledge.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SELF_ANSWERS, isAboutBeeZilla, relevantAnswers, selfKnowledgeNote } from "../src/lib/buzzy/self-knowledge";

let failures = 0;
function check(ok: unknown, label: string): void {
  if (ok) return;
  failures++;
  console.error("FAIL", label);
}

// ── The answer base ──────────────────────────────────────────────────
check(SELF_ANSWERS.length === 50, `exactly 50 answers (got ${SELF_ANSWERS.length})`);
const ids = new Set<string>();
const root = resolve(import.meta.dirname, "..");
const fileText = new Map<string, string>();
for (const e of SELF_ANSWERS) {
  check(/^sk-\d{3}$/.test(e.id), `${e.id}: id shape`);
  check(!ids.has(e.id), `${e.id}: unique id`);
  ids.add(e.id);
  check(e.q.trim().length > 8 && e.q.trim().endsWith("?"), `${e.id}: question`);
  check(e.a.trim().length > 20, `${e.id}: answer`);
  check(e.surfaces.length > 0 && e.surfaces.every((s) => s === "website" || s === "desktop"), `${e.id}: surfaces`);
  check(e.sources.length > 0, `${e.id}: at least one source`);
  for (const src of e.sources) {
    const path = resolve(root, src.file);
    if (!existsSync(path)) { check(false, `${e.id}: source file ${src.file} exists`); continue; }
    if (!fileText.has(path)) fileText.set(path, readFileSync(path, "utf8"));
    check(fileText.get(path)!.includes(src.symbol), `${e.id}: "${src.symbol}" is still in ${src.file}`);
  }
}

// ── Which messages are questions about BeeZilla ───────────────────────
const about = [
  "What is BeeZilla?",
  "what can you do?",
  "Can you make music?",
  "can you make 3D models?",
  "Are you able to read my files?",
  "How do I share a document?",
  "how do I invite a teammate?",
  "What does Lockdown do?",
  "what's advocate mode",
  "Does open mode publish my work?",
  "what is a recipe?",
  "What are Honey Drops?",
  "Is my whiteboard saved?",
  "How many chats left do I have on the free plan?",
  "Can I download it as a PDF?",
  "how long does a public link last?",
  "Can BeeZilla send emails for me?",
  "can you look things up on the web?",
  "What is the Inspiration wall?",
  "Is there a desktop app?",
  "what does the do it button do?",
  "can you remember things about my business?",
];
const notAbout = [
  "Write a menu for my cafe.",
  "make me a song about rain",
  "What's the capital of France?",
  "Draft a letter to my landlord about the leak.",
  "How do I fix a leaking tap?",
  "What's a good recipe for banana bread?",
  "Can you make me a song about the sea?",
  "Make a 3D model of a chair",
  "Summarise this contract for me.",
  "What is the history of Rome?",
  "Create a spreadsheet of my monthly costs",
  "How much does a plumber charge per hour?",
  "Write an invitation for my daughter's birthday party",
  "Plan a three-day trip to Lisbon",
  "what's the weather tomorrow?",
  "Translate this into Spanish please",
  "Help me write a cover letter",
  "Give me five names for a bakery",
  "turn this into a slide deck",
  "Who won the World Cup in 2022?",
  "",
];
for (const m of about) check(isAboutBeeZilla(m), `about BeeZilla: ${JSON.stringify(m)}`);
for (const m of notAbout) check(!isAboutBeeZilla(m), `not about BeeZilla: ${JSON.stringify(m)}`);

// ── Finding the right answer ──────────────────────────────────────────
function idOf(question: string): string {
  const hit = SELF_ANSWERS.find((e) => e.q === question);
  if (!hit) throw new Error(`no answer with question ${question}`);
  return hit.id;
}
const expected: [string, string][] = [
  ["What does Lockdown do?", "What exactly does Lockdown turn off?"],
  ["How do I share a document?", "How do I share a document?"],
  ["What are Honey Drops?", "What are Honey Drops?"],
  ["Can I make music on the free plan?", "Can I make music on the free plan?"],
  ["how do I invite a teammate?", "How do I invite a teammate?"],
  ["How long does a public link last?", "How long does a public link last, and can I turn it off?"],
  ["Is my whiteboard saved to my account?", "Is my Whiteboard saved to my account?"],
  ["Can BeeZilla send emails?", "Can BeeZilla send emails for me?"],
  ["what formats can I download?", "What file formats can I download?"],
];
for (const [message, question] of expected) {
  const top = relevantAnswers(message, 3).map((e) => e.id);
  check(top.includes(idOf(question)), `"${message}" finds "${question}" in the top 3 (got ${top.join(", ")})`);
}
check(relevantAnswers("zzzz qqqq").length === 0, "nonsense finds nothing");

// ── The note added to the chat ────────────────────────────────────────
check(selfKnowledgeNote("Write a menu for my cafe.") === null, "no note for a work request");
const note = selfKnowledgeNote("What does Lockdown do?");
check(typeof note === "string" && note.startsWith("VERIFIED FACTS ABOUT BEEZILLA"), "note for a question about BeeZilla");
check(typeof note === "string" && note.length <= 2600, `note stays short (${note?.length})`);
check(typeof note === "string" && note.includes("not sure rather than guessing"), "note forbids guessing");

if (failures) {
  console.error(`self-knowledge: ${failures} check(s) failed`);
  process.exit(1);
}
console.log(`self-knowledge: all checks passed (${SELF_ANSWERS.length} answers, ${about.length + notAbout.length} routing cases)`);
