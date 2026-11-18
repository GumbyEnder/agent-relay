/**
 * BeeZilla works its own screen (src/lib/buzzy/pilot.ts).
 *
 * Pins which messages become on-screen actions and which stay ordinary chat,
 * that less privacy or the microphone always waits for the owner's Allow, that a
 * plan never half-does a message, and that a page change can only be last. The
 * page's own controls are checked by name in public/buzzy/talk.html and
 * browse.js, so a renamed button fails here instead of in front of the owner.
 *
 * Run: npx tsx scripts/test-app-actions.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appActionsNote, planAppActions, type AppAction } from "../src/lib/buzzy/pilot";

let failures = 0;
function check(ok: unknown, label: string): void {
  if (ok) return;
  failures++;
  console.error("FAIL", label);
}

function brief(plan: AppAction[] | null): string {
  return plan ? plan.map((s) => `${s.do}${s.value ? ":" + s.value : ""}${s.ask ? "?" : ""}`).join(" + ") : "null";
}

// ── Commands and the plans they make ────────────────────────────────
const commands: [string, string, ("advocate" | "lockdown" | "open")?][] = [
  ["Open the whiteboard", "whiteboard:open"],
  ["can you open the whiteboard please?", "whiteboard:open"],
  ["Hey BeeZilla, close the whiteboard.", "whiteboard:close"],
  ["show me only music", "inspiration:audio"],
  ["Show pictures on the inspiration wall", "inspiration:photo"],
  ["just show 3D models", "inspiration:3d"],
  ["show me everything", "inspiration:all"],
  ["show my library", "tab:library"],
  ["open the inspiration wall", "tab:inspiration"],
  ["take me to my library", "go:library"],
  ["go to recipes", "go:recipes"],
  ["open my business profile", "go:profile"],
  ["switch to lockdown", "privacy:lockdown", "open"],
  ["lock it down", "privacy:lockdown", "advocate"],
  ["switch to open mode", "privacy:open?", "advocate"],
  ["set my privacy to advocate", "privacy:advocate?", "lockdown"],
  ["set my privacy to advocate", "privacy:advocate", "open"],
  ["turn off lockdown", "privacy:advocate?", "lockdown"],
  ["switch to open", "privacy:open?"],
  ["switch to work mode", "mode:work"],
  ["go back to chat mode", "mode:chat"],
  ["show my history", "history"],
  ["start a new chat", "newChat"],
  ["read your replies out loud", "speak:on"],
  ["turn off speak replies", "speak:off"],
  ["let's talk", "voice?"],
  ["start voice", "voice?"],
  ["switch to lockdown and open the whiteboard", "privacy:lockdown + whiteboard:open", "open"],
  ["open the whiteboard, then show me only music", "whiteboard:open + inspiration:audio"],
  ["show me only pictures and take me to my library", "inspiration:photo + go:library"],
];
for (const [message, want, privacy] of commands) {
  const got = brief(planAppActions(message, privacy));
  check(got === want, `${JSON.stringify(message)} (privacy ${privacy ?? "unknown"}) → ${want} (got ${got})`);
}

// ── Ordinary chat stays chat ─────────────────────────────────────────
const chat = [
  "How do I open the whiteboard?",
  "What's on the whiteboard?",
  "Can you make music?",
  "make me a song about rain",
  "show me pictures of my cafe",
  "Write a menu for my cafe.",
  "open a document about our sales",
  "let's talk about my business plan",
  "What does Lockdown do?",
  "Is my whiteboard saved?",
  "go to the shops",
  "take me to Lisbon",
  "switch to the other supplier",
  "open the whiteboard and write a poem",
  "take me to my library and open the whiteboard",
  "show me only music and pictures and documents and 3d and everything",
  "",
  "open the whiteboard ".repeat(12),
];
for (const message of chat) check(planAppActions(message) === null, `chat stays chat: ${JSON.stringify(message.slice(0, 60))}`);

// ── Less privacy and the microphone always wait for Allow ───────────
for (const message of ["switch to open mode", "turn on advocate", "start the microphone"]) {
  const plan = planAppActions(message, "lockdown");
  check(plan?.[0]?.ask === true, `${JSON.stringify(message)} from Lockdown waits for Allow`);
}
check(!planAppActions("switch to lockdown", "open")?.[0]?.ask, "more privacy needs no Allow");

// ── The note tells the model what the page is doing ──────────────────
const note = appActionsNote(planAppActions("switch to open mode", "lockdown")!);
check(note.startsWith("ON-SCREEN ACTIONS"), "note heading");
check(note.includes("Switch privacy to Open") && note.includes("waits for the owner to press Allow"), "note names the step and the Allow");

// ── The page still has every control the plans press ────────────────
const root = resolve(import.meta.dirname, "..");
const talk = readFileSync(resolve(root, "public/buzzy/talk.html"), "utf8");
const browse = readFileSync(resolve(root, "public/buzzy/browse.js"), "utf8");
const pilot = readFileSync(resolve(root, "public/buzzy/pilot.js"), "utf8");
const navjs = readFileSync(resolve(root, "public/buzzy/nav.js"), "utf8");
for (const id of ["boardToggle", "privacyBtn", "privacyClose", "modeTabs", "sessionsToggle", "newSessionBtn", "micBtn"]) {
  check(talk.includes(`id="${id}"`), `talk.html still has #${id}`);
  check(pilot.includes(`#${id}`), `pilot.js presses #${id}`);
}
// One voice switch: the header control built by nav.js, not a page-level pill.
check(navjs.includes('mic.id = "bzVoiceMic"'), "nav.js builds the #bzVoiceMic voice switch");
check(pilot.includes("#bzVoiceMic"), "pilot.js presses the one voice switch");
for (const tab of ["inspiration", "library", "memory", "experts"]) check(talk.includes(`data-tab="${tab}"`), `talk.html has the ${tab} tab`);
for (const mode of ["advocate", "lockdown", "open"]) check(talk.includes(`data-mode="${mode}"`), `talk.html has the ${mode} privacy choice`);
for (const kind of ["all", "photo", "audio", "3d", "document"]) check(browse.includes(`"${kind}"`), `browse.js offers the ${kind} kind`);
check(browse.includes("bz-insp-kinds"), "browse.js draws the kind choices pilot.js presses");
check(talk.includes('<script src="/buzzy/pilot.js"></script>') && talk.includes("window.BeeZillaPilot.run(data.actions)"), "talk.html loads pilot.js and runs a reply's actions");

if (failures) {
  console.error(`app-actions: ${failures} check(s) failed`);
  process.exit(1);
}
console.log(`app-actions: all checks passed (${commands.length} commands, ${chat.length} chat messages)`);
