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
 */

export type PrivacyMode = "advocate" | "lockdown" | "open";

export interface AppAction {
  do: "go" | "tab" | "inspiration" | "whiteboard" | "privacy" | "mode" | "history" | "newChat" | "speak" | "voice";
  /** The place, tab, kind or mode, or "open"/"close", "on"/"off". */
  value?: string;
  /** The step in plain words, as the steps card shows it. */
  say: string;
  /** Wait for the owner to press Allow before doing it. */
  ask?: boolean;
}

const MAX_STEPS = 4;
const MAX_LENGTH = 160;

function normal(message: string): string {
  return String(message || "")
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// "Hey BeeZilla, could you please …", "… for me now please!"
const LEAD = /^(?:(?:hey|hi|ok|okay)\s+)?(?:(?:bee ?zilla|buzzy)\s*[,:!]?\s+)?(?:please\s+|pls\s+|kindly\s+)?(?:(?:can|could|would|will) you\s+(?:please\s+)?)?/;
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
  // ── Chat or Work ─────────────────────────────────────────────────────
  {
    re: /^(?:(?:switch|change|go|turn|move|flip)(?: (?:it|this|me))?(?: back)?(?: (?:to|into|over to))?|start|use|enter|open|let's switch to|lets switch to|let's use|lets use) (work|chat) mode$/,
    make: (m) => ({ do: "mode", value: m[1]!, say: `Switch to ${m[1] === "work" ? "Work" : "Chat"} mode` }),
  },
  // ── History ──────────────────────────────────────────────────────────
  {
    re: /^(?:show|open|see|view|pull up|bring up)(?: me)?(?: my| the)? (?:chat history|history|past chats|old chats|previous chats|earlier chats|past conversations|previous conversations)$/,
    make: () => ({ do: "history", say: "Open your History" }),
  },
  // ── A new chat ───────────────────────────────────────────────────────
  {
    re: /^(?:(?:start|open|begin|make|create)(?: me)? (?:a )?(?:new|fresh|blank) (?:chat|conversation|talk)|new chat)$/,
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

/** The actions a command asks for, or null when the message is not one. */
export function planAppActions(message: string, current?: PrivacyMode | null): AppAction[] | null {
  const m = normal(message);
  if (!m || m.length > MAX_LENGTH) return null;
  const body = m.replace(LEAD, "").replace(TAIL, "");
  if (!body) return null;
  const clauses = body.split(/\s*,?\s*(?:\band then\b|\bthen\b|\band\b)\s*|\s*,\s*/).filter(Boolean);
  if (!clauses.length || clauses.length > MAX_STEPS) return null;
  const plan: AppAction[] = [];
  for (const clause of clauses) {
    let step: AppAction | null = null;
    for (const rule of RULES) {
      const hit = clause.match(rule.re);
      if (hit) { step = rule.make(hit, current ?? undefined); break; }
    }
    // One clause the list doesn't cover and the whole message is ordinary chat:
    // never half-do what was asked.
    if (!step) return null;
    plan.push(step);
  }
  // Going to another page ends this one, so it can only be the last step.
  if (plan.slice(0, -1).some((s) => s.do === "go")) return null;
  return plan;
}

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
