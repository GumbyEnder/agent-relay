/**
 * BeeZilla works the Idea Board for you, by talking (owner, 2026-11-20):
 *
 *   "The Beezilla whiteboard also needs a comprehensive list of tools so that you can
 *    navigate and do whatever you need to do. By just talking to Beezilla… if a person
 *    feels lost, it'll ask them, would you like me to zoom out and show you the whole
 *    board?… it's got to be able to do everything the person does within the board
 *    for the person by voice command."
 *
 * Same rules as the rest of BeeZilla's on-screen actions (pilot.ts): a step comes only
 * from this closed list, matched against the person's own words — the model never
 * writes one — and the page carries it out where they can watch, with Stop
 * (public/buzzy/pilot.js → board.act in whiteboard.js). Everything here can be undone
 * like the person's own edits (Ctrl/⌘+Z); clearing the whole board waits for Allow.
 * A command has to name the board or a card ("the beach photo", "the poster step")
 * so ordinary chat ("show me pictures of my cafe", "delete my account") stays chat.
 */

export interface BoardStep {
  do: "board";
  /** The verb: fit, zoomIn, zoomOut, zoom100, focus, enlarge, note, step, agent, end, connect,
   *  disconnect, select, deselect, remove, rename, write, edit, duplicate, move, area,
   *  sell, recipe, history, keys, undo, redo, find, start, browser, orchestrate. */
  value: string;
  /** The card(s) it works on, in the person's words ("the beach photo", "everything"). */
  target?: string;
  /** The second card: connect X to Y, put X next to Y. */
  to?: string;
  /** Words to write on a card. */
  text?: string;
  /** A card's or an area's or a recipe's name. */
  title?: string;
  /** move: left | right | up | down | next | under | above | leftof. */
  dir?: string;
  /** sell: drops | honey | open. */
  choice?: string;
  /** find: what to look for; start: what to start from; orchestrate: what the person said. */
  query?: string;
  /** find: picture | music | video | 3d | file. */
  kind?: string;
  /** Filled by the server: the file found in the Library, or the starting board. */
  url?: string;
  contentType?: string;
  graph?: unknown;
  say: string;
  ask?: boolean;
}

// Things on a board, by the words people use for them.
const NOUNS =
  "who it serves|core identity|drawings?|sketch(?:es)?|doodles?|cards?|notes?|sticky notes?|steps?|skills?|agent\\.? ?md|agent md|instructions(?: card)?|end results?|outputs?|" +
  "pictures?|photos?|images?|pics?|songs?|tracks?|music|videos?|clips?|3d models?|models?|documents?|docs?|files?|" +
  "links?|areas?|orchestrations?|boxes|box";
const ENDS_IN_NOUN = new RegExp(`(?:^|\\s)(?:${NOUNS})$`);
const OF_NOUN = new RegExp(`^(?:the |my |that |this )?(?:${NOUNS}) (?:of|with|about|called|named|for) [a-z0-9 .'-]{2,60}$`);
const BOARD = "(?:the |my |this )?(?:idea board|white ?board|board)";
const ON_BOARD = new RegExp(`\\s+(?:on|from|in|off) ${BOARD}$`);

// "this card", "the one I'm holding": a card the owner is pointing at or holding as they
// speak (owner, 2026-11-21: "it could hover over something or grab something and say,
// what do I do with this?… And it knows what this or that is").
const HOLDING = /^(?:this card|that card|the (?:one|thing|card) (?:i'?m|i am) (?:holding|dragging|moving)|what (?:i'?m|i am) (?:holding|dragging))$/;
const POINTED = /^(?:this|that|this one|that one|this card|that card|the (?:one|thing|card) (?:i'?m|i am) (?:holding|dragging|moving)|what (?:i'?m|i am) (?:holding|dragging))$/;

/** "the beach photo" or "the beach photo on the board" — names a card. */
function cardPhrase(s: string | undefined): string | null {
  let t = String(s || "").trim().replace(/^["“]|["”]$/g, "").trim();
  if (!t) return null;
  if (ON_BOARD.test(t)) t = t.replace(ON_BOARD, "").trim();
  if (!t) return null;
  // "the dog in the picture", "the background from my photo": a part of a picture,
  // not a card ("the picture of the dog" is a card).
  if (/\b(?:from|in|inside|at|on|onto|into)\b/.test(t)) return null;
  if (/^(?:it|this|that|this one|that one|them|these|those|everything|all of it|all of them|the selection)$/.test(t)) return t;
  // What they point at or hold as they speak (whiteboard.js knows which card that is).
  if (HOLDING.test(t)) return t;
  if (OF_NOUN.test(t)) return t;            // "the picture of the dog", "the note about prices"
  return ENDS_IN_NOUN.test(t) ? t : null;
}
function clean(s: string | undefined): string {
  return String(s || "").trim().replace(/^["“'‘]+|["”'’]+$/g, "").trim();
}
function cap(s: string): string { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function quote(s: string): string { return "“" + clean(s).slice(0, 60) + "”"; }

type Rule = { re: RegExp; make: (m: RegExpMatchArray) => BoardStep | null; closed?: true };

const KIND_OF_FIND: Record<string, string> = {
  picture: "picture", pictures: "picture", photo: "picture", photos: "picture", image: "picture", images: "picture", pic: "picture", pics: "picture",
  song: "music", songs: "music", track: "music", tracks: "music", music: "music",
  video: "video", videos: "video", clip: "video", clips: "video",
  document: "file", documents: "file", doc: "file", file: "file", files: "file",
};

const RULES: Rule[] = [
  // ── Seeing the board ─────────────────────────────────────────────────
  {
    re: new RegExp(
      "^(?:zoom (?:all the way )?out(?: (?:to|so (?:i|we) can|and) (?:see|show)(?: me| us)? (?:the )?(?:whole|entire|full) (?:board|thing|whiteboard|idea board)| (?:to |so i can )?see everything| all the way)" +
      "|(?:show|let me see|give me)(?: me)? (?:the )?(?:whole|entire|full) (?:board|whiteboard|idea board|thing)" +
      "|show(?: me)? everything on " + BOARD +
      "|fit (?:everything|it all|the board|the whole board)(?: on (?:the )?screen)?|fit to (?:the )?screen" +
      "|(?:see|view) the (?:whole|entire|full) board|(?:a )?bird'?s[- ]eye view|(?:an )?overview of " + BOARD + ")$",
    ),
    make: () => ({ do: "board", value: "fit", say: "Zoom out to show the whole board" }),
    closed: true,
  },
  { re: /^zoom out(?: (?:a bit|a little|some|more|a lot))?$/, make: () => ({ do: "board", value: "zoomOut", say: "Zoom out" }) },
  { re: /^zoom in(?: (?:a bit|a little|some|more|a lot))?$/, make: () => ({ do: "board", value: "zoomIn", say: "Zoom in" }) },
  {
    re: /^(?:(?:reset|set) (?:the )?zoom(?: (?:back )?to (?:100(?: ?%| percent)|normal))?|zoom (?:back )?to (?:100(?: ?%| percent)|normal(?: size)?|actual size)|(?:go )?back to (?:normal|actual|full|regular) size|normal size|actual size)$/,
    make: () => ({ do: "board", value: "zoom100", say: "Back to 100%" }),
    closed: true,
  },
  {
    re: /^(?:zoom (?:in )?(?:on|to)|cent(?:er|re)(?: the board)? on|focus on) (.+)$/,
    make: (m) => ({ do: "board", value: "focus", target: clean(m[1]), say: `Show ${quote(m[1]!)}` }),
  },
  {
    re: new RegExp(`^(?:show me|find|where(?:'s| is)|take me to|go to|jump to|look at) (.+?) on ${BOARD}$`),
    make: (m) => (/\b(?:and|put|add|drop|stick)\b/.test(m[1]!) ? null : { do: "board", value: "focus", target: clean(m[1]), say: `Show ${quote(m[1]!)}` }),
  },
  {
    // "make this bigger": the card they point at or hold, shown as big as the screen
    // allows. Only for "this"/"that": "make it bigger" right after a picture stays a
    // change to that picture (pictureChange.ts).
    re: /^(?:make|show) (.+?) (?:bigger|larger)(?: on (?:the |my )?screen)?$/,
    make: (m) => { const t = clean(m[1]); return POINTED.test(t) ? { do: "board", value: "enlarge", target: t, say: "Show it bigger" } : null; },
  },
  // ── Making cards ─────────────────────────────────────────────────────
  {
    re: new RegExp(
      `^(?:add|make|create|put|write|leave|stick|jot(?: down)?|drop|post)(?: me| down| up)?(?: a| an| another| one more)?(?: new)? (?:sticky )?note` +
      `(?: (?:on|to|onto) ${BOARD})?(?:(?:,|:| -)?\\s*(?:that says|saying|which says|with the words?|to say|that reads|reading|about|with|:)\\s*(.+))?$`,
    ),
    make: (m) => ({ do: "board", value: "note", text: clean(m[1]), say: m[1] ? `Add a note: ${quote(m[1])}` : "Add a note" }),
  },
  {
    re: new RegExp(`^(?:add|make|create|put)(?: a| an| another| one more)?(?: new)? (?:step|skill)(?: (?:on|to) ${BOARD})?(?:(?:,|:)?\\s*(?:called|named|titled|:)\\s*(.+)|\\s+(?:to|that|for) (?!my |the |a |an |our |your |his |her |their )(.+))?$`),
    make: (m) => {
      const t = m[1] || m[2];
      return { do: "board", value: "step", title: t ? cap(clean(t)) : undefined, say: t ? `Add the step ${quote(cap(clean(t)))}` : "Add a step" };
    },
  },
  {
    re: new RegExp(`^(?:add|make|create|put|write|set)(?: an?| the| my)? (?:agent'?s )?(?:core identity|agent\\.? ?md|agent md|instructions card|agent card)(?: card)?(?: (?:on|to) ${BOARD})?(?:(?:,|:)?\\s*(?:saying|that says|to say|as|:)\\s*(.+))?$`),
    make: (m) => ({ do: "board", value: "agent", text: m[1] ? clean(m[1]) : undefined, say: m[1] ? "Write the core identity" : "Add the core identity" }),
  },
  {
    re: /^(?:the |my |your )?(?:agent'?s )?core identity (?:is|should be|:)\s*(.+)$/,
    make: (m) => ({ do: "board", value: "agent", text: clean(m[1]), say: "Write the core identity" }),
  },
  // ── Who it serves: the person BeeZilla works for (private when shared) ──
  {
    re: /^(?:(?:add|set|make|change|update|write)(?: a| the)? )?who it serves(?: card)?(?:(?:,|:)?\s*(?:is|to|as|:|saying|that says)\s*(.+))?$/,
    make: (m) => ({ do: "board", value: "person", text: m[1] ? clean(m[1]) : undefined, say: m[1] ? "Write who it serves" : "Add who it serves" }),
  },
  // ── The globe: a job BeeZilla does in its own browser ─────────────────
  {
    re: new RegExp(`^(?:add|make|create|put|drop|give me|open)(?: me)?(?: a| an| another| one more| the)?(?: new)? (?:globe|browser (?:node|job|card|step|use)|web browser(?: node)?)(?: (?:on|to|onto) ${BOARD})?$`),
    make: () => ({ do: "board", value: "browser", say: "Add a browser node (the globe)" }),
  },
  // ── Drawing on the board ─────────────────────────────────────────────
  {
    re: new RegExp(`^(?:add|start|make|create|open|begin|give me)(?: me)?(?: a| an| the| my)?(?: new)? (?:drawing|sketch|doodle)(?: (?:on|to) ${BOARD})?(?:(?:,|:)?\\s*(?:of|for|that becomes|to become|called)\\s*(.+))?$|^(?:let me|i want to|i'd like to|i wanna) (?:draw|sketch|doodle)(?: something)?(?: on ${BOARD})?$`),
    make: (m) => ({ do: "board", value: "sketch", text: m[1] ? clean(m[1]) : undefined, say: "Start a drawing" }),
  },
  {
    re: /^(?:turn|make|change|convert) (?:the |my |this |that )?(?:drawing|sketch|doodle) (?:into|in to|to) (.+)$/,
    make: (m) => ({ do: "board", value: "render", text: clean(m[1]), say: `Make the drawing into ${quote(m[1]!)}` }),
  },
  {
    re: /^make (?:the |my |this |that )?(?:drawing |sketch |doodle )?(?:it )?real$|^make it real$/,
    make: () => ({ do: "board", value: "render", say: "Make the drawing real" }),
  },
  {
    re: /^(?:clear|erase|wipe|empty) (?:the |my |this )?(?:drawing|sketch|doodle)$/,
    make: () => ({ do: "board", value: "clearDrawing", say: "Clear the drawing" }),
  },
  {
    re: new RegExp(`^(?:add|make|create|put|set)(?: an?| the)? (?:end result|final result|output)(?: card)?(?: (?:on|to) ${BOARD})?(?:(?:,|:)?\\s*(?:called|named|of|to be|that says|saying|:)\\s*(.+))?$`),
    make: (m) => ({ do: "board", value: "end", title: m[1] ? cap(clean(m[1])) : undefined, say: m[1] ? `Add the end result ${quote(cap(clean(m[1])))}` : "Add an end result" }),
  },
  // ── Lines ────────────────────────────────────────────────────────────
  {
    re: /^(?:connect|join|link|hook up|wire(?: up)?|attach|plug)(?: up)? (.+?) (?:to|with|into|onto|and) (.+)$/,
    make: (m) => {
      const a = cardPhrase(m[1]), b = cardPhrase(m[2]);
      return a && b ? { do: "board", value: "connect", target: a, to: b, say: `Connect ${quote(a)} to ${quote(b)}` } : null;
    },
  },
  {
    re: /^(?:draw|make|add) a (?:line|connection|link) (?:from|between) (.+?) (?:to|and) (.+)$/,
    make: (m) => {
      const a = cardPhrase(m[1]), b = cardPhrase(m[2]);
      return a && b ? { do: "board", value: "connect", target: a, to: b, say: `Connect ${quote(a)} to ${quote(b)}` } : null;
    },
  },
  {
    re: /^(?:disconnect|unlink|unhook|detach|separate) (.+?) (?:from|and) (.+)$|^(?:remove|delete|erase|take away|cut) the (?:line|connection|link) (?:from|between) (.+?) (?:to|and) (.+)$/,
    make: (m) => {
      const a = cardPhrase(m[1] || m[3]), b = cardPhrase(m[2] || m[4]);
      return a && b ? { do: "board", value: "disconnect", target: a, to: b, say: `Remove the line between ${quote(a)} and ${quote(b)}` } : null;
    },
  },
  // ── Selecting, changing, removing ───────────────────────────────────
  {
    re: new RegExp(`^(?:select|highlight) (?:everything|all(?: (?:the )?cards)?)(?: on ${BOARD})?$`),
    make: () => ({ do: "board", value: "select", target: "everything", say: "Select everything" }),
  },
  {
    re: /^(?:select|highlight) (.+)$/,
    make: (m) => { const t = cardPhrase(m[1]); return t ? { do: "board", value: "select", target: t, say: `Select ${quote(t)}` } : null; },
  },
  { re: /^(?:deselect|unselect|clear (?:the )?selection|select nothing)(?: everything| all)?$/, make: () => ({ do: "board", value: "deselect", say: "Clear the selection" }) },
  {
    re: new RegExp(`^(?:clear|empty|wipe|reset)(?: (?:the|my))? (?:idea board|white ?board|board)$|^(?:remove|delete|erase|clear) everything (?:on|from|off) ${BOARD}$`),
    make: () => ({ do: "board", value: "remove", target: "everything", say: "Clear the whole board (Ctrl/⌘+Z brings it back)", ask: true }),
  },
  {
    re: /^(?:remove|delete|erase|get rid of|throw away|bin|trash|take away|take off) (.+)$/,
    make: (m) => {
      const t = cardPhrase(m[1]);
      if (!t || /^(?:everything|all of it|all of them)$/.test(t)) return null;
      return { do: "board", value: "remove", target: t, say: `Remove ${quote(t)}` };
    },
  },
  {
    re: /^(?:rename|retitle) (.+?) (?:to|as) (.+)$/,
    make: (m) => { const t = cardPhrase(m[1]); return t ? { do: "board", value: "rename", target: t, title: cap(clean(m[2])), say: `Rename ${quote(t)} to ${quote(cap(clean(m[2])))}` } : null; },
  },
  {
    re: /^(?:call|name) (this area|the area|that area|this step|the step|this note|the note|this card|the card|it|this|that) (.+)$/,
    make: (m) => ({ do: "board", value: "rename", target: m[1]!, title: cap(clean(m[2])), say: `Name it ${quote(cap(clean(m[2])))}` }),
  },
  {
    re: /^(?:change|make|set) (.+?) (?:to say|to read|so it says) (.+)$/,
    make: (m) => { const t = cardPhrase(m[1]); return t ? { do: "board", value: "write", target: t, text: clean(m[2]), say: `Change ${quote(t)} to say ${quote(m[2]!)}` } : null; },
  },
  {
    re: /^(?:edit|change) (.+)$|^open (?:up )?(.+? (?:note|step|skill|card|agent\.? ?md|end result|area))(?: to edit(?: it)?)?$/,
    make: (m) => {
      const t = cardPhrase(m[1] || m[2]);
      return t && !/^(?:it|this|that|everything)$/.test(t) ? { do: "board", value: "edit", target: t, say: `Open ${quote(t)} to edit` } : null;
    },
  },
  {
    re: /^(?:duplicate|copy|clone|make a copy of) (.+)$/,
    make: (m) => { const t = cardPhrase(m[1]); return t ? { do: "board", value: "duplicate", target: t, say: `Duplicate ${quote(t)}` } : null; },
  },
  {
    re: /^(?:move|drag|shift|slide|nudge) (.+?) (?:a (?:bit|little) |a lot |way |over |further )?(?:to the )?(left|right|up|down|higher|lower)$/,
    make: (m) => {
      const t = cardPhrase(m[1]);
      const dir = ({ higher: "up", lower: "down" } as Record<string, string>)[m[2]!] || m[2]!;
      return t ? { do: "board", value: "move", target: t, dir, say: `Move ${quote(t)} ${dir}` } : null;
    },
  },
  {
    re: /^(?:move|put|drag|place) (.+?) (next to|beside|by|under|below|underneath|above|over|left of|to the left of|right of|to the right of) (.+)$/,
    make: (m) => {
      const a = cardPhrase(m[1]), b = cardPhrase(m[3]);
      const dir = /under|below|beneath/.test(m[2]!) ? "under" : /above|over/.test(m[2]!) ? "above" : /left/.test(m[2]!) ? "leftof" : "next";
      return a && b ? { do: "board", value: "move", target: a, to: b, dir, say: `Put ${quote(a)} ${m[2]} ${quote(b)}` } : null;
    },
  },
  // ── Areas, recipes, selling ──────────────────────────────────────────
  {
    re: /^(?:make|create|draw|put|add)(?: an?)? (?:area|box|frame|group)(?: (?:around|for|with|over|round) (.+?))?(?: (?:called|named) (.+))?$/,
    make: (m) => {
      const t = m[1] ? (cardPhrase(m[1]) ?? (/^(?:everything|all of it|the whole board|the board|all the cards)$/.test(m[1]) ? "everything" : null)) : "it";
      if (!t) return null;
      return { do: "board", value: "area", target: t, title: m[2] ? cap(clean(m[2])) : undefined, say: m[2] ? `Make the area ${quote(cap(clean(m[2])))}` : "Make an area" };
    },
  },
  {
    re: /^(?:put|group|cordon off|fence off|box up) (.+?)(?: (?:in|into) (?:an? |one )?(?:area|box|group))?(?: (?:called|named) (.+))?$/,
    make: (m) => {
      if (!/^(?:cordon|fence|box|group)/.test(m[0]) && !/(?:in|into) (?:an? |one )?(?:area|box|group)/.test(m[0])) return null;
      const t = cardPhrase(m[1]) ?? (/^(?:everything|the whole board|the board)$/.test(m[1]!) ? "everything" : null);
      return t ? { do: "board", value: "area", target: t, title: m[2] ? cap(clean(m[2])) : undefined, say: "Make an area" } : null;
    },
  },
  {
    re: /^(?:write|put|type) (.+?) (?:on|in|into) (.+)$/,
    make: (m) => { const t = cardPhrase(m[2]); return t && !/\b(?:area|box|group)$/.test(t) ? { do: "board", value: "write", target: t, text: clean(m[1]), say: `Write ${quote(m[1]!)} on ${quote(t)}` } : null; },
  },
  {
    re: /^(?:sell|trade|open[- ]?source|share) (it|this|that|this area|the area|this orchestration|the orchestration|my orchestration|the whole board|the board|my board|this board|everything|.+? area)(?: (?:for|as) (honey drops|honey|free))?$/,
    make: (m) => {
      const verb = m[0].split(" ")[0]!;
      const choice = /open/.test(verb) || m[2] === "free" ? "open" : m[2] === "honey drops" ? "drops" : m[2] === "honey" ? "honey" : undefined;
      const whole = /board|everything/.test(m[1]!);
      return { do: "board", value: "sell", target: whole ? undefined : m[1], choice, say: "Open Sell this orchestration (coming soon)" };
    },
  },
  {
    re: /^(?:save|turn|keep) (.+?) (?:as|into|in to) (?:a |my )?recipe(?: (?:called|named) (.+))?$/,
    make: (m) => {
      const t = cardPhrase(m[1]) ?? (/^(?:the whole board|the board|everything)$/.test(m[1]!) ? "everything" : null);
      return t ? { do: "board", value: "recipe", target: t, title: m[2] ? cap(clean(m[2])) : undefined, say: m[2] ? `Save the recipe ${quote(cap(clean(m[2])))}` : "Save it as a recipe" } : null;
    },
  },
  {
    re: /^(?:create|make) (?:a )?recipe (?:from|of|out of) (.+?)(?: (?:called|named) (.+))?$/,
    make: (m) => {
      const t = cardPhrase(m[1]) ?? (/^(?:the whole board|the board|everything)$/.test(m[1]!) ? "everything" : null);
      return t ? { do: "board", value: "recipe", target: t, title: m[2] ? cap(clean(m[2])) : undefined, say: "Save it as a recipe" } : null;
    },
  },
  // ── Panels, undo ─────────────────────────────────────────────────────
  {
    re: new RegExp(`^(?:show|open|see)(?: me)? (?:the |my )?(?:(?:idea board|white ?board|board)(?:'s)? (?:history|versions)|(?:history|earlier versions|older versions|versions) of ${BOARD})$`),
    make: () => ({ do: "board", value: "history", say: "Open the board's History" }),
    closed: true,
  },
  {
    re: new RegExp(`^(?:show|read|list|tell)(?: me| us)?(?: (?:the|all the|what the|what are the))? (?:keyboard )?(?:shortcuts|controls|keys|buttons)(?: (?:are|is))?(?: (?:on|of|for) ${BOARD})?$`),
    make: () => ({ do: "board", value: "keys", say: "Show the board's shortcuts" }),
    closed: true,
  },
  { re: /^(?:undo(?: that| it| the last (?:thing|change|step))?|take that back|go back one step)$/, make: () => ({ do: "board", value: "undo", say: "Undo" }) },
  { re: /^redo(?: that| it)?$/, make: () => ({ do: "board", value: "redo", say: "Redo" }) },
  // The flow on the board, in the Orchestrate editor (validator, Mermaid, save).
  {
    re: /^(?:open|show|put|send|take|move)(?: me)?(?: it| this| that| (?:the|my|this) (?:flow|orchestration|workflow|pipeline|automation))?(?: (?:up )?in| into| to| over to) (?:the )?orchestrat(?:e|ion|or)(?: editor| page| mode| tab)?$/,
    make: () => ({ do: "board", value: "openOrchestrate", say: "Open the flow in Orchestrate" }),
    closed: true,
  },
  // ── Grabbing something you already have, or a simple starting board ──
  {
    re: new RegExp(
      "^(?:grab|get|fetch|find|pull up|bring|put|add)(?: me)?(?: (?:a|an|the|my|some|that))? " +
      "(picture|pictures|photo|photos|image|images|pic|pics|song|songs|track|tracks|music|video|videos|clip|clips|document|documents|doc|file|files)" +
      "(?: (?:of|with|about|called|named|from|for))? (.+?)" +
      "(?: (?:from|in|out of) (?:my |the )?(?:library|inspiration|files))?" +
      `(?: (?:and )?(?:put|add|drop|stick)(?: it| them)? (?:on|onto|to|in) ${BOARD}| (?:on|onto|to) ${BOARD})?$`,
    ),
    make: (m) => {
      const q = clean(m[2]).replace(/^(?:of|with|about) /, "");
      if (!q || q.length < 2) return null;
      return { do: "board", value: "find", kind: KIND_OF_FIND[m[1]!] || "picture", query: q, say: `Put ${KIND_OF_FIND[m[1]!] === "music" ? "the song" : "the " + (KIND_OF_FIND[m[1]!] || "picture")} ${quote(q)} on the board` };
    },
  },
  {
    re: new RegExp(
      "^(?:grab|get|fetch|find|bring|put|add)(?: me)? (?:the|my|that|our) (.+?) " +
      "(picture|photo|image|pic|song|track|video|clip|document|doc|file)" +
      "(?: (?:from|in|out of) (?:my |the )?(?:library|inspiration|files))?" +
      `(?: (?:and )?(?:put|add|drop|stick)(?: it)? (?:on|onto|to|in) ${BOARD}| (?:on|onto|to) ${BOARD})?$`,
    ),
    make: (m) => {
      const q = clean(m[1]);
      if (!q || /\b(?:from|in|of)\b/.test(q)) return null;
      return { do: "board", value: "find", kind: KIND_OF_FIND[m[2]!] || "picture", query: q, say: `Put ${quote(q + " " + m[2])} on the board` };
    },
  },
  {
    re: /^(?:start (?:me )?(?:off )?(?:with|from)|load|give me|use|put up|bring up|set up|show me)(?: (?:a|an|the|someone else'?s|somebody else'?s))? (?:simple )?(?:starting|starter|template|example|sample|ready-made|readymade) (?:board|whiteboard|orchestration)?(?: (?:for|about|of|on|to make) (.+))?$/,
    make: (m) => ({ do: "board", value: "start", query: clean(m[1]), say: m[1] ? `Put a simple starting board for ${quote(m[1])} on the board` : "Put a simple starting board on the board" }),
  },
];

/**
 * The globe joined to a step, in one sentence (owner, 2026-11-23): "OK, when you get to that step,
 * go to [the site] and, you know, go to /create and then type in these instructions to create the
 * sound and then download the sound and send it elsewhere." The whole rest of the sentence is the
 * job, in their words — so this is matched before a message is cut into clauses (pilot.ts), and only
 * when the job is something done on a website (a site, the browser or a website is named).
 */
const AT_STEP = /^(?:(?:ok(?:ay)?|so|and|alright|right|now)[,.]?\s+)*(?:when(?:ever)?|once|as soon as|after) (?:you|we|it|beezilla|bee zilla) (?:get|gets|come|comes|reach|reaches|are|is|hit|hits)(?: (?:to|at|on))? (.{2,70}?) step\b[,:;.]?\s+(?:(?:please|then|just|you|i want you to|i need you to|go ahead and)\s+)*(.{6,1200})$/;
const AT_STEP_TOO = /^(?:at|for|in|on|during) (.{2,70}?) step\b[,:;]?\s+(?:(?:please|then|just|you)\s+)*(?:use (?:your|the|beezilla'?s) (?:own )?browser (?:to|and)\s+)?(.{6,1200})$/;
const WEBBY = /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|ai|io|net|org|app|co|dev|me|so|xyz|fm|tv|studio|music|art|us|uk|de|fr|ca|site|online|tech|gg|ly|to|sh)\b|\bbrowser\b|\bwebsite\b|\bweb ?site\b|\bweb page\b|\blog ?in\b|\bsign ?in\b)/;
// The job says to DO something there: not "for this step we need a website", not a question.
const DOING = /^(?:(?:please|then|just|and|you)\s+)*(?:go|head|navigate|open|visit|log ?in|sign ?in|use (?:your|the|beezilla'?s) (?:own )?browser|type|fill|click|press|download|upload|search|make|create|generate|post|send|record|browse|find)\b/;
export function browserAtStep(body: string): BoardStep | null {
  const m = AT_STEP.exec(body) ?? AT_STEP_TOO.exec(body);
  if (!m) return null;
  const task = clean(m[2]).replace(/^(?:to|and)\s+/, "");
  if (!task || !WEBBY.test(task) || !DOING.test(task) || /\?\s*$/.test(task)) return null;
  let which = clean(m[1]).replace(/^(?:the|my|your|our)\s+/, "");
  // "that step", "this step", "the next step": the one they mean on the board (the selection).
  const target = /^(?:that|this|it|the one|that one|this one)$/.test(which) || !which ? "that" : `the ${which} step`;
  which = which || "that";
  return { do: "board", value: "browser", target, text: task, say: target === "that" ? "Join a browser job to that step" : `Join a browser job to ${quote(target)}` };
}

/** A whole message that is one fixed board phrase ("zoom out and show me the whole board"). */
export function closedBoardStep(body: string): BoardStep | null {
  for (const rule of RULES) {
    if (!rule.closed) continue;
    const hit = body.match(rule.re);
    if (hit) return rule.make(hit);
  }
  return null;
}

/** One clause of what the person said, as a board step, or null. */
export function boardStep(clause: string): BoardStep | null {
  for (const rule of RULES) {
    const hit = clause.match(rule.re);
    if (hit) {
      const step = rule.make(hit);
      if (step) return step;
    }
  }
  return null;
}

// ── Orchestrations: BeeZilla builds a flow on the board, live ───────────────
// Owner, 2026-11-24: "tell the AI what we want to orchestrate, and it can put the
// pieces together live in front of us… you should just be able to talk to Beezilla,
// and that should be all you need to do to make an orchestration." These are the
// words that ask for one: "orchestrate …", "make me a workflow / pipeline / automation
// / agent team that …", or a change to a flow on the board ("add an approval before
// sending", "make the research run in parallel", "make the draft repeat until it's
// good"). The board then asks BeeZilla for the pieces (boardOrchestrator.ts) and puts
// them up one by one. A question about orchestrations ("what's an orchestration?")
// stays chat, and "a starting board / template" stays the simple starting boards.
const FLOW_NOUN =
  "(?:orchestrations?|work ?flows?|flow ?charts?|flows?|pipelines?|automations?|process(?:es)?|agent teams?|teams? of (?:ai )?agents|" +
  "multi-?agent (?:systems?|teams?|flows?|workflows?|setups?)|(?:ai )?agents? (?:flows?|workflows?|pipelines?|teams?|setups?)|sequences? of (?:steps|agents))";
const MAKE_VERB =
  "(?:make|build|create|design|set up|setup|put together|lay out|layout|map out|draw|sketch(?: out)?|plan(?: out)?|wire up|give me|draft|generate|construct|assemble|whip up|spin up|come up with)";
// Asking for a new one: "orchestrate …", "an orchestration for …", "build me a workflow …".
const MAKE_RULES: RegExp[] = [
  // "orchestrate a weekly newsletter…", "orchestrate this"
  /^orchestrate\b\s*\S/,
  // "an orchestration for onboarding new clients"
  /^(?:an? |the |my |our )?orchestration (?:for|to|that|of|about|where|which|so|when)\b/,
  // "build me a workflow that…", "set up an automation for…", "make a content pipeline"
  new RegExp(`^${MAKE_VERB}(?: me| us)?(?: an?| the| my| our| another| one)?(?: (?!of\\b|for\\b|with\\b)[a-z0-9'-]+){0,2}? ${FLOW_NOUN}\\b`),
];
// Changing the one on the board. Only when the board has one (the server knows from the
// board it is sent), so "make the song repeat" or "add a review after the intro" with
// no flow on the board stay what they were.
const CHANGE_RULES: RegExp[] = [
  // A piece of a flow put before / after / between others.
  // ("add a spelling check before my approval", "put a quick human review after the draft")
  /^(?:add|put|insert|place|drop|stick|slot)(?: in)?(?: an?| another| one more| the)?(?: (?!of\b|for\b|with\b|called\b|named\b)[a-z'-]+){0,2}? (?:steps?|approvals?(?: steps?)?|decisions?|checks?|reviews?|loops?|branch(?:es)?|triggers?|schedules?|parallel steps?|agents?(?: steps?)?|tools?(?: calls?)?|end results?)\b.*\b(?:before|after|between|in between|at the (?:start|end|beginning)|in parallel)\b/,
  // "make the research run in parallel", "run these at the same time"
  /^(?:make|have|let|run) (?:the )?.{2,60}? (?:run |happen |go )?(?:in parallel|at the same time)$/,
  // "make the draft repeat until it's good", "wrap the review in a loop"
  /^(?:make|have) (?:the )?.{2,60}? (?:repeat|loop)(?: (?:until|up to|at most|while) .+)?$/,
  /^(?:wrap|put) .{2,60}? in a loop\b/,
];
const STARTER_WORDS = /\b(?:starting|starter|template|example|sample|ready-?made)\b/;
// A thing to make, not a flow to draw: "a sales pipeline report", "a process document".
const DELIVERABLE = new RegExp(
  `${FLOW_NOUN} (?:reports?|documents?|docs?|decks?|slides?|presentations?|spreadsheets?|sheets?|pdfs?|summar(?:y|ies)|memos?|emails?|letters?|articles?|templates?|checklists?|write-?ups?|one-?pagers?|briefs?|proposals?|guides?|manuals?|polic(?:y|ies)|sops?|videos?|songs?|pictures?|images?)\\b`,
);
// Software plumbing, not an orchestration: "set up a data pipeline in Python", "a CI pipeline".
const CODE = /\b(?:in|with|using) (?:python|javascript|typescript|js|ts|node(?:\.js)?|sql|bash|shell|java|kotlin|swift|golang|rust|c\+\+|c#|php|ruby|scala|dbt|airflow|spark|kafka|terraform|yaml)\b|\b(?:ci(?:\/cd)?|github actions|cron ?jobs?|etl|dag|repo|repository)\b/;
// Music, video and pictures loop and repeat too: "make the beat loop", "make the song repeat".
const MEDIA = /\b(?:songs?|beats?|tracks?|music|melod(?:y|ies)|chorus|verses?|riffs?|samples?|videos?|clips?|gifs?|animations?|sounds?|audio|drums?|bass|tunes?|playlists?|pictures?|images?|photos?|logos?|slides?)\b/;

/**
 * The person asked BeeZilla to build an orchestration on the board, or (when the board
 * has one) to change it. `boardHasFlow` comes from the board the turn was sent with.
 */
export function orchestrateStep(body: string, opts: { boardHasFlow?: boolean } = {}): BoardStep | null {
  // "I want to build…", "help me set up…", "let's make…", "can we draw…": the ask itself.
  const t = String(body || "").trim()
    .replace(/^(?:(?:i|we) (?:want|need|would like|'d like|wanna)(?: you)?(?: to)?|help me(?: to)?|let'?s|lets|(?:can|could) we|please)\s+/, "");
  if (!t || STARTER_WORDS.test(t) || CODE.test(t)) return null;
  // A question is not a request ("what is an orchestration?", "how do I build a workflow?").
  if (/^(?:what|why|how|who|when|where|which|is|are|does|do|did|can orchestration|should)\b/.test(t) || /\?$/.test(t)) return null;
  const making = MAKE_RULES.some((re) => re.test(t)) && !DELIVERABLE.test(t);
  const changing = !making && !!opts.boardHasFlow && !MEDIA.test(t) && CHANGE_RULES.some((re) => re.test(t));
  if (!making && !changing) return null;
  return { do: "board", value: "orchestrate", query: t, say: "Build it on the Idea Board, piece by piece" };
}

// ── Lost on the board, and "yes" to BeeZilla's own offers ──────────────────
const LOST =
  /\b(?:i'?m|i am|feel(?:ing)?|getting|got)\s+(?:so |a bit |a little |kind of |kinda |totally |completely |really )?(?:lost|confused|overwhelmed|disoriented)(?:\s+(?:here|now|again|on (?:the|this|my) (?:board|whiteboard|idea board|screen|page)|with (?:the|this) (?:board|whiteboard)))?[.!?\s]*$|\bwhere (?:is|did|are|has|have) (?:everything|it all|all my stuff|my stuff|my cards|the cards|all the cards|my work|all my work|the stuff)\b|\bi can'?t (?:find|see) (?:anything|my (?:stuff|cards|work)|where|the cards|what'?s going on)\b|\bwhat am i (?:even )?looking at\b|\bhow do i get back\b|\bwhere am i\b/;

/** The person sounds lost on the board: BeeZilla offers to show the whole board. */
export function soundsLost(message: string): boolean {
  return LOST.test(String(message || "").toLowerCase().replace(/[’]/g, "'"));
}
export const LOST_OFFER = "Would you like me to zoom out and show you the whole board?";
export function lostNote(): string {
  return (
    "\n\nTHE PERSON SOUNDS LOST ON THE IDEA BOARD. Start your reply by asking exactly: \"" + LOST_OFFER + "\" " +
    "Then, in one or two short sentences, say where things are: BeeZilla's tools are down the left side, zoom and " +
    "History are in the bottom-right corner, and F1 (or the keyboard button there) lists every shortcut. Don't zoom " +
    "or change anything yourself; wait for their answer."
  );
}

const YES = /^(?:yes|yeah|yea|yep|yup|sure|ok(?:ay)?|please|please do|do it|do that|go ahead|go for it|sounds good|absolutely|definitely|yes please|that would be great|that'?d be great|let'?s do it|let'?s do that|why not|of course|great|perfect)(?: please| thanks| thank you)?[.! ]*$/;

/** "yes" to BeeZilla's last question, when that question offered a board step. */
export function acceptedOffer(message: string, lastReply: string | null | undefined, startingBoardTitles: string[]): BoardStep | null {
  const m = String(message || "").toLowerCase().replace(/[’]/g, "'").replace(/^(?:oh |um+ |uh+ |well |hmm+ )+/, "").replace(/,/g, "").trim();
  if (!YES.test(m)) return null;
  const last = String(lastReply || "");
  if (!last.includes("?")) return null;
  const low = last.toLowerCase();
  if (/zoom out/.test(low) && /(?:whole|entire|full) board|everything/.test(low)) {
    return { do: "board", value: "fit", say: "Zoom out to show the whole board" };
  }
  if (/starting board/.test(low)) {
    const hit = startingBoardTitles.find((t) => low.includes(t.toLowerCase()));
    if (hit) return { do: "board", value: "start", query: hit, say: `Put a simple starting board for ${quote(hit)} on the board` };
  }
  return null;
}
