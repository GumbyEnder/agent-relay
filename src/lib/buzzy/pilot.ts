/**
 * BeeZilla works its own screen (roadmap phase 6, live interface piloting:
 * "observable UI actions so work mode actually executes authorized tasks rather
 * than merely answering as chat"; "show what is happening, teach through visible
 * steps, and support cancellation, failure recovery and permission checks").
 *
 * When a chat message tells BeeZilla to do something in BeeZilla itself — "open
 * the whiteboard", "show me only music", "switch to Lockdown", "take me to my
 * library" — the reply carries a short plan of on-screen actions. The Talk page
 * (public/buzzy/pilot.js) carries them out one at a time where the owner can
 * watch: each control lights up before it is pressed, Stop ends the run at any
 * step, a control that is not on the page stops the run and says which, and a
 * step that makes the account less private or turns the microphone on waits for
 * the owner's Allow.
 *
 * Plans come only from this closed list, matched against the owner's own words.
 * The model never writes one, and no action reaches outside BeeZilla's pages.
 *
 * The Idea Board's own steps (zoom, add a note, connect two cards, make an area…)
 * are listed in boardPilot.ts and run by the board itself (whiteboard.js `act`).
 */
import { acceptedOffer, boardStep, browserAtStep, closedBoardStep, orchestrateStep, type BoardStep } from "./boardPilot";

export type PrivacyMode = "advocate" | "lockdown" | "open";

export type AppAction = PageAction | BoardStep;
export interface PageAction {
  do: "go" | "tab" | "inspiration" | "whiteboard" | "privacy" | "history" | "newChat" | "speak" | "voice";
  /** The place, tab, kind or mode, or "open"/"close", "on"/"off". */
  value?: string;
  /** The step in plain words, as the steps card shows it. */
  say: string;
  /** Wait for the owner to press Allow before doing it. */
  ask?: boolean;
}

const MAX_STEPS = 4;
const MAX_LENGTH = 160;
/** An orchestration can take a few sentences to describe ("…then I approve it, then…"). */
const ORCH_MAX_LENGTH = 1500;

function normal(message: string): string {
  return String(message || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// "Hey BeeZilla, could you please …", "Um, okay, so can you …", "… for me now please!"
const LEAD = /^(?:(?:hey|hi|ok|okay|um+|uh+|so|alright|all right|right|now|and)\s*[,.]?\s+)*(?:(?:bee ?zilla|buzzy|debzilla|gzilla)\s*[,:!]?\s+)?(?:please\s+|pls\s+|kindly\s+)?(?:(?:can|could|would|will) you\s+(?:please\s+)?|i want you to\s+|i'd like you to\s+|i need you to\s+)?/;
const TAIL = /(?:\s+(?:please|pls|for me|now|right now|thanks|thank you))*\s*[.!?]*$/;

const PLACES: Record<string, string> = {
  talk: "talk", "talk page": "talk",
  library: "library",
  memory: "memory",
  experts: "experts",
  recipes: "recipes",
  capabilities: "capabilities",
  studio: "studio",
  sketch: "sketch",
  profile: "profile", "business profile": "profile", "company profile": "profile",
};
const PLACE_NAMES: Record<string, string> = {
  talk: "Talk", library: "your Library", memory: "Memory", experts: "Experts", recipes: "Recipes",
  capabilities: "Capabilities", studio: "Studio", sketch: "Sketch", profile: "your business profile",
};
const PLACE_WORDS = "talk(?: page)?|library|memory|experts|recipes|capabilities|studio|sketch|profile|business profile|company profile";

const KINDS: Record<string, string> = {
  music: "audio", songs: "audio", audio: "audio", tracks: "audio",
  pictures: "photo", photos: "photo", images: "photo",
  "3d": "3d", "3d models": "3d", models: "3d",
  documents: "document", docs: "document", papers: "document",
  everything: "all", all: "all", "all of it": "all",
};
const KIND_SAY: Record<string, string> = {
  audio: "Show only music on the Inspiration wall",
  photo: "Show only pictures on the Inspiration wall",
  "3d": "Show only 3D models on the Inspiration wall",
  document: "Show only documents on the Inspiration wall",
  all: "Show everything on the Inspiration wall",
};
const KIND_WORDS = "music|songs|audio|tracks|pictures|photos|images|3d models|3d|models|documents|docs|papers|everything|all of it|all";

const RANK: Record<PrivacyMode, number> = { lockdown: 0, advocate: 1, open: 2 };
const MODE_NAME: Record<PrivacyMode, string> = { lockdown: "Lockdown", advocate: "Advocate", open: "Open" };

type Rule = { re: RegExp; make: (m: RegExpMatchArray, current?: PrivacyMode) => AppAction | null };

function privacyStep(mode: PrivacyMode, current?: PrivacyMode): AppAction {
  // Less privacy than now (or than an unknown "now") is the owner's call: ask.
  const ask = current ? RANK[mode] > RANK[current] : mode !== "lockdown";
  return { do: "privacy", value: mode, say: `Switch privacy to ${MODE_NAME[mode]}`, ...(ask ? { ask: true } : {}) };
}

const RULES: Rule[] = [
  // ── The Inspiration wall: what it shows ──────────────────────────────
  {
    re: new RegExp(`^(?:(?:only|just) show|show|see|view|display|filter(?: to)?|switch to)(?: me)?(?: only| just)?(?: the| my)? (${KIND_WORDS})(?: only)?(?: (?:on|in) (?:the )?inspiration(?: wall)?)?$`),
    make: (m) => {
      const kind = KINDS[m[1]!];
      return kind ? { do: "inspiration", value: kind, say: KIND_SAY[kind]! } : null;
    },
  },
  // ── The Idea Board ───────────────────────────────────────────────────
  {
    re: /^(?:open|show|bring up|pull up|start|launch|give me)(?: up)?(?: me)?(?: the| my| a)? ?white ?board$/,
    make: () => ({ do: "whiteboard", value: "open", say: "Open the Idea Board" }),
  },
  {
    re: /^(?:close|hide|shut|put away|dismiss)(?: the| my)? ?white ?board$/,
    make: () => ({ do: "whiteboard", value: "close", say: "Close the Idea Board" }),
  },
  {
    re: /^(?:open|show|bring up|pull up|unfold)(?: up)?(?: me)?(?: the| my)? idea board$|^(?:open|see|show|bring up|pull up|unfold|bring back)(?: up)?(?: me)?(?: the| my)? board(?: back)?(?: up)?$|^(?:open|bring) (?:it|the board) back(?: up)?$/,
    make: () => ({ do: "whiteboard", value: "open", say: "Open the Idea Board" }),
  },
  {
    re: /^(?:close|hide|fold|put away|tuck away|minimi[sz]e)(?: the| my)? (?:idea board|board)(?: away)?$|^fold (?:it|the idea board|the board) away$/,
    make: () => ({ do: "whiteboard", value: "close", say: "Fold the Idea Board away" }),
  },
  // ── The tabs under the Talk bar ──────────────────────────────────────
  {
    re: /^(?:show|see|view)(?: me)?(?: my| the)? (inspiration(?: wall)?|library|memory|experts)(?: tab)?$|^open(?: up)?(?: the| my)? (inspiration(?: wall)?|inspiration tab|library tab|memory tab|experts tab)$/,
    make: (m) => {
      const tab = (m[1] || m[2] || "").replace(/ (?:wall|tab)$/, "");
      return { do: "tab", value: tab, say: `Show the ${tab[0]!.toUpperCase()}${tab.slice(1)} tab` };
    },
  },
  // ── Other places ─────────────────────────────────────────────────────
  {
    re: new RegExp(`^(?:(?:go|take me|bring me|navigate|head|jump|switch)(?: back)? to|open(?: up)?)(?: the| my)? (${PLACE_WORDS})(?: page)?$`),
    make: (m) => {
      const place = PLACES[m[1]!];
      return place ? { do: "go", value: place, say: `Go to ${PLACE_NAMES[place]}` } : null;
    },
  },
  // ── Privacy ──────────────────────────────────────────────────────────
  {
    re: /^(?:switch|change|set|turn|put|go|move)(?: (?:it|me|my privacy|privacy|the privacy|privacy mode|my privacy mode))?(?: (?:to|into|on|onto))? (lockdown|advocate|open)(?: mode)?$/,
    make: (m, current) => privacyStep(m[1] as PrivacyMode, current),
  },
  {
    re: /^(?:turn on|enable|use|activate|enter) (lockdown|advocate|open mode|advocate mode|lockdown mode)$/,
    make: (m, current) => privacyStep(m[1]!.replace(/ mode$/, "") as PrivacyMode, current),
  },
  {
    re: /^lock (?:it |everything |me |this )?down$/,
    make: (_m, current) => privacyStep("lockdown", current),
  },
  {
    re: /^(?:turn off|leave|exit|disable|stop|end) lockdown(?: mode)?$/,
    make: (_m, current) => privacyStep("advocate", current),
  },
  // ── History ──────────────────────────────────────────────────────────
  {
    re: /^(?:show|open|see|view|pull up|bring up)(?: me)?(?: my| the)? (?:chat history|history|past chats|old chats|previous chats|earlier chats|past conversations|previous conversations)$/,
    make: () => ({ do: "history", say: "Open your History" }),
  },
  // ── A new chat ───────────────────────────────────────────────────────
  {
    re: /^(?:(?:start|open|begin|make|create|put in|add)(?: me)? (?:a )?(?:new|fresh|blank) (?:chat|conversation|talk)(?: icon| button| card| window| tab)?|new (?:chat|conversation))$/,
    make: () => ({ do: "newChat", say: "Start a new chat" }),
  },
  // ── Speak replies ────────────────────────────────────────────────────
  {
    re: /^(?:(?:turn on|enable|start|switch on)(?: the)? (?:speak replies|spoken replies|voice replies|reading (?:your )?replies(?: (?:aloud|out loud))?)|(?:read|speak|say) (?:your )?(?:replies|answers) (?:aloud|out loud))$/,
    make: () => ({ do: "speak", value: "on", say: "Turn on Speak replies" }),
  },
  {
    re: /^(?:(?:turn off|disable|stop|switch off)(?: the)? (?:speak replies|spoken replies|voice replies|reading (?:your )?replies(?: (?:aloud|out loud))?)|stop (?:reading|speaking) (?:your )?(?:replies|answers)(?: (?:aloud|out loud))?)$/,
    make: () => ({ do: "speak", value: "off", say: "Turn off Speak replies" }),
  },
  // ── Voice: the microphone is the owner's call ────────────────────────
  {
    re: /^(?:(?:start|turn on|switch on|open)(?: the)? (?:voice|voice chat|voice mode|mic|microphone)|(?:let's|lets) talk(?: out loud)?|start talking)$/,
    make: () => ({ do: "voice", say: "Turn on the microphone and start voice", ask: true }),
  },
];

export interface PlanContext {
  /** BeeZilla's previous reply: "yes" to its own offer ("…zoom out and show you the whole board?"). */
  lastReply?: string | null;
  /** The starting boards BeeZilla can offer (starterBoards.ts), by title. */
  startingBoards?: string[];
  /** The board this turn was sent with has a flow on it: "add a check before…" changes it. */
  boardHasFlow?: boolean;
}

/** Does the board text a turn carries (whiteboard.js compile) hold a flow to change? */
export function boardHasFlow(boardText: string | null | undefined): boolean {
  return /^The orchestration on the board\b|^Step \d+ — /m.test(String(boardText || ""));
}

function clauseStep(clause: string, current?: PrivacyMode | null): AppAction | null {
  for (const rule of RULES) {
    const hit = clause.match(rule.re);
    if (hit) return rule.make(hit, current ?? undefined);
  }
  return boardStep(clause);
}

// Commands are matched in lower case; the words they carry onto the board keep the
// person's own capitals ("add a note saying Call Maria at 5").
function keepCase(message: string, piece: string | undefined, capital = false): string | undefined {
  if (!piece) return piece;
  const orig = String(message || "").replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
  const i = orig.toLowerCase().indexOf(piece.toLowerCase());
  const got = i >= 0 ? orig.slice(i, i + piece.length) : piece;
  return capital ? got.charAt(0).toUpperCase() + got.slice(1) : got;
}
function withCase(message: string, plan: AppAction[] | null): AppAction[] | null {
  if (!plan) return plan;
  return plan.map((s) => (s.do === "board" ? { ...s, text: keepCase(message, s.text), title: keepCase(message, s.title, true) } : s));
}

/** The actions a command asks for, or null when the message is not one. */
export function planAppActions(message: string, current?: PrivacyMode | null, ctx?: PlanContext): AppAction[] | null {
  const plan = withCase(message, planInLowerCase(message, current, ctx));
  // "Orchestrate…": BeeZilla is handed the person's own words, capitals and all.
  return plan && plan.length === 1 && plan[0]!.do === "board" && plan[0]!.value === "orchestrate"
    ? [{ ...plan[0]!, query: String(message || "").replace(/\s+/g, " ").trim().slice(0, ORCH_MAX_LENGTH) }]
    : plan;
}
function planInLowerCase(message: string, current?: PrivacyMode | null, ctx?: PlanContext): AppAction[] | null {
  const m = normal(message);
  if (!m) return null;
  // "When you get to the song step, go to … and download the song": a job for BeeZilla's own
  // browser, joined to that step. The whole sentence is the job, however long, so it comes first.
  // (It starts "when/once/at … step", which no orchestration request below does.)
  if (m.length <= 1300) {
    const atStep = browserAtStep(m.replace(LEAD, "").replace(TAIL, ""));
    if (atStep) return [atStep];
  }
  // Building or changing an orchestration on the board (boardPilot.ts orchestrateStep):
  // the whole message is the request, however long, so it is never split into clauses.
  if (m.length <= ORCH_MAX_LENGTH) {
    const orch = orchestrateStep(m.replace(LEAD, "").replace(TAIL, ""), { boardHasFlow: ctx?.boardHasFlow });
    if (orch) return [orch];
  }
  // A note can carry a sentence or two; any other command is short.
  if (m.length > (/\bnote\b/.test(m) ? 400 : MAX_LENGTH)) return null;
  const yes = acceptedOffer(m, ctx?.lastReply, ctx?.startingBoards ?? []);
  if (yes) return [yes];
  const body = m.replace(LEAD, "").replace(TAIL, "");
  if (!body) return null;
  const fixed = closedBoardStep(body);
  if (fixed) return [fixed];
  const clauses = body.split(/\s*,?\s*(?:\band then\b|\bthen\b|\band\b)\s*|\s*,\s*/).filter(Boolean);
  let plan: AppAction[] | null = null;
  if (clauses.length && clauses.length <= MAX_STEPS) {
    plan = [];
    for (const clause of clauses) {
      const step = clauseStep(clause, current);
      // One clause the list doesn't cover: never half-do what was asked.
      if (!step) { plan = null; break; }
      plan.push(step);
    }
  }
  // "connect the note and the picture", "add a note saying eggs and milk": one board
  // step whose words hold an "and".
  if (!plan) {
    const whole = boardStep(body);
    return whole ? [whole] : null;
  }
  // Going to another page ends this one, so it can only be the last step.
  if (plan.slice(0, -1).some((s) => s.do === "go")) return null;
  return plan;
}

/**
 * The person asked BeeZilla to build or change an orchestration on the Idea Board, or
 * to open the one there in the Orchestrate editor: a turn whose work is on the board.
 */
export function asksToOrchestrate(message: string, ctx?: PlanContext): boolean {
  const m = normal(message);
  if (!m || m.length > ORCH_MAX_LENGTH) return false;
  if (orchestrateStep(m.replace(LEAD, "").replace(TAIL, ""), { boardHasFlow: ctx?.boardHasFlow })) return true;
  const plan = planAppActions(message, null, ctx);
  return !!plan && plan.some((s) => s.do === "board" && s.value === "openOrchestrate");
}

/**
 * On a turn where BeeZilla builds on the board, the board does the work, so the reply
 * only says so. Measured 2026-11-24 with a local model: told only in the leading system
 * note, it answered "I can't set up the recurring send" while the board was building
 * it. It goes on the end of the model's copy of the person's message, in their voice:
 * a note in the leading system message is ignored (server.ts afterNotes), and a system
 * message after theirs is refused outright by some models ("system message must be at
 * the beginning", local Qwen) — the person's own AI key can be any of them.
 */
export const ORCHESTRATE_USER_LINE =
  "(You're building this on my Idea Board right now, card by card, and I can watch it happen there. " +
  "Just tell me in one short sentence that you're building it on the board. Don't say you can't build workflows, " +
  "automations, schedules or orchestrations, don't ask me anything first, and don't list the steps.)";

/** The system note that tells the model what the page is doing. */
export function appActionsNote(plan: AppAction[]): string {
  const steps = plan.map((s, i) => `${i + 1}) ${s.say}${s.ask ? " (waits for the owner to press Allow)" : ""}`).join("; ");
  return (
    "ON-SCREEN ACTIONS — the owner asked BeeZilla to do something in BeeZilla itself, and the page is doing it now, " +
    `step by step where they can see it: ${steps}. Reply in one short sentence saying you are doing it ` +
    '(for example "Opening the Idea Board now."). Mention a step that waits for Allow. Do not explain how to do it ' +
    "yourself, do not say it is already done, and add nothing else."
  );
}
