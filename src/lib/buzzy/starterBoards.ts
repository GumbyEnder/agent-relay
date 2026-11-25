/**
 * Simple starting boards: someone already worked out the steps, so you don't start
 * from a blank board.
 *
 * Owner, 2026-11-20: "Sometimes loading somebody else's whiteboard will give them a
 * starting point they can customize from. But that whiteboard has got to be a simple
 * one, otherwise it gets too complicated for them." And the core principle: "you
 * should never seek to reinvent the wheel. You should always seek to say, what's
 * already out there?"
 *
 * Each starter is a tiny orchestration — its core identity (agent.md), two or three steps, the end result
 * — that BeeZilla can put on the Idea Board in one go ("start me off with a logo
 * board", or "yes" to its offer). Every one stays at five cards or fewer
 * (STARTING_BOARD_MAX_CARDS); the test fails if one grows. When the Orchestration Store opens,
 * the orchestrations people open-source join these. (Not the outcome journeys in
 * starters.ts, BZ-F028: those are guided conversations; these are boards.)
 */

export const STARTING_BOARD_MAX_CARDS = 5;

export interface StartingBoardNode { id: string; kind: "agent" | "skill" | "output"; title: string; body: string; x: number; y: number }
export interface StartingBoardGraph { nodes: StartingBoardNode[]; links: Array<{ from: string; to: string }> }
export interface StartingBoard {
  id: string;
  title: string;
  /** One line: what it makes. */
  about: string;
  /** Words people use for it; matched with the title. */
  words: string[];
  graph: StartingBoardGraph;
}

const COL = 300;

/** The core identity → each step in turn → the end result, left to right. */
function chain(agent: string, steps: Array<[string, string]>, end: [string, string]): StartingBoardGraph {
  const nodes: StartingBoardNode[] = [{ id: "a", kind: "agent", title: "Core identity", body: agent, x: 0, y: 0 }];
  steps.forEach(([title, body], i) => nodes.push({ id: "s" + (i + 1), kind: "skill", title, body, x: COL * (i + 1), y: 0 }));
  nodes.push({ id: "e", kind: "output", title: end[0], body: end[1], x: COL * (steps.length + 1), y: 0 });
  const links = nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id }));
  return { nodes, links };
}

export const STARTING_BOARDS: StartingBoard[] = [
  {
    id: "logo",
    title: "Logo for a small business",
    about: "Three simple logo ideas, then the favourite polished.",
    words: ["logo", "brand", "branding", "business", "shop", "bakery", "cafe", "company", "icon", "mark"],
    graph: chain(
      "Ask for the business name, what it sells and two words for how it should feel. Keep it simple and readable at small sizes.",
      [["Gather the brand words", "The name, what it sells, two feeling words, any colours to keep."],
       ["Draw three logo ideas", "Three different simple ideas on a plain background."],
       ["Polish the favourite", "Clean up the one they pick; make a version that works small."]],
      ["Logo", "A clean logo picture on a plain background, plus a small version."],
    ),
  },
  {
    id: "event-song",
    title: "Song for an opening or event",
    about: "A short song made for one moment, from its mood and a hook.",
    words: ["song", "music", "jingle", "tune", "opening", "launch", "party", "event", "anthem", "track"],
    graph: chain(
      "Ask what the event is, the mood, and how long the song should be. Keep the words short and singable.",
      [["Pick the mood and length", "Upbeat or calm, about 30 seconds unless they say otherwise."],
       ["Write the hook", "One line people will remember, with the name in it."],
       ["Make the song", "The finished track, ready to play."]],
      ["Song", "A short song to play at the event."],
    ),
  },
  {
    id: "event-poster",
    title: "Poster for an event",
    about: "The event's details, a poster picture and a caption to post with it.",
    words: ["poster", "flyer", "event", "fair", "concert", "sale", "announcement", "sign", "banner"],
    graph: chain(
      "Ask for the event name, date, place and the one thing people must know. Big, readable words.",
      [["Gather the details", "Name, date, time, place, and the one thing to remember."],
       ["Draw the poster", "A bold picture with the details easy to read."],
       ["Write the caption", "Two short lines to post with the poster."]],
      ["Poster", "A poster picture and a caption to share."],
    ),
  },
  {
    id: "product-pictures",
    title: "Pictures of a product",
    about: "A small set of product pictures in one style.",
    words: ["product", "photo", "photos", "pictures", "shop", "store", "listing", "catalog", "catalogue", "item"],
    graph: chain(
      "Ask what the product is, its colours and where the pictures will be used. Keep the product looking exactly like itself.",
      [["Describe the product", "What it is, its shape and colours, and one detail that must show."],
       ["Make three pictures", "Three pictures in one style: plain background, in use, close-up."]],
      ["Product pictures", "Three matching pictures, ready for a shop or a post."],
    ),
  },
  {
    id: "product-3d",
    title: "3D model of a product",
    about: "A turnable 3D model from a description or a picture.",
    words: ["3d", "model", "object", "product", "prototype", "figure", "toy", "print", "printing"],
    graph: chain(
      "Ask what it is, how big it is and what it is made of. A picture of it helps most.",
      [["Describe the shape", "What it is, its size, material and colours, or a picture of it."],
       ["Make the 3D model", "One clean model of the object, nothing around it."]],
      ["3D model", "A 3D model file to view, share or print."],
    ),
  },
  {
    id: "price-list",
    title: "Price list for services",
    about: "A one-page price list, from the services and what they cost.",
    words: ["price", "prices", "pricing", "price list", "rates", "menu", "services", "cost", "quote", "list"],
    graph: chain(
      "Ask for each service and its price. Never invent a price: ask for the ones that are missing.",
      [["List the services", "Every service, in the order customers think of them."],
       ["Set the prices", "Their prices; ask about any that are missing."],
       ["Lay out the page", "One clean page, easy to scan."]],
      ["Price list", "A one-page price list document."],
    ),
  },
  {
    id: "welcome-email",
    title: "Welcome email for new customers",
    about: "A short, warm email for someone who just bought or signed up.",
    words: ["email", "welcome", "customer", "customers", "newsletter", "message", "onboarding", "thank you"],
    graph: chain(
      "Ask who the customers are and what they just bought or joined. Warm, short, one clear next step.",
      [["Who it's for", "Who they are and what they just did."],
       ["Write the email", "A subject line and a short, warm email with one next step."]],
      ["Welcome email", "An email ready to copy into their mail program."],
    ),
  },
  {
    id: "launch-week",
    title: "Launch week plan",
    about: "One thing to do each day of a launch week, with the posts written.",
    words: ["launch", "plan", "week", "schedule", "marketing", "campaign", "release", "opening", "calendar"],
    graph: chain(
      "Ask what is launching and on which day. One small, doable thing per day.",
      [["Pick the launch day", "The day, and what is launching."],
       ["Plan one thing a day", "Seven days, one action each."],
       ["Write the posts", "A short post for each day."]],
      ["Launch week plan", "A day-by-day plan with the posts written."],
    ),
  },
  {
    id: "social-post",
    title: "Social media post with a picture",
    about: "A picture and a caption that go together, for one post.",
    words: ["social", "post", "instagram", "facebook", "tiktok", "caption", "linkedin", "twitter", "x"],
    graph: chain(
      "Ask what the post is about and where it goes. The picture and the words should say the same thing.",
      [["Write the caption", "Two or three short lines and a few fitting tags."],
       ["Make the picture", "One picture that matches the caption."]],
      ["Post", "A picture and a caption, ready to post."],
    ),
  },
  {
    id: "space-picture",
    title: "A picture of the Milky Way for a child",
    about: "Our galaxy, drawn simply, with a label showing where Earth is.",
    words: ["milky way", "galaxy", "space", "stars", "planet", "planets", "universe", "solar system", "child", "kids", "school"],
    graph: chain(
      "Make it friendly and easy for a child to understand. Bright, simple, and true to the real shape.",
      [["Pick the style", "Cartoon or real-looking; ask if they don't say."],
       ["Draw the galaxy", "The Milky Way's spiral, with a small label: You are here."]],
      ["Milky Way picture", "One picture of the Milky Way, made for a child."],
    ),
  },
];

const STOP = new Set(["a", "an", "the", "for", "of", "my", "me", "to", "and", "with", "about", "on", "some", "make", "create", "board", "starter", "starting", "simple", "template", "example", "please"]);

function words(s: string): string[] {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
}

/** Starting boards that fit what someone wants to make, best first. */
export function findStartingBoards(query: string, limit = 3): Array<StartingBoard & { score: number }> {
  const q = String(query || "").toLowerCase();
  const qs = words(q);
  if (!qs.length) return [];
  return STARTING_BOARDS.map((s) => {
    let score = 0;
    const title = s.title.toLowerCase();
    for (const w of s.words) {
      if (w.includes(" ") ? q.includes(w) : qs.includes(w) || qs.includes(w + "s") || qs.some((x) => x === w.replace(/s$/, ""))) score += 2;
    }
    for (const w of qs) if (w.length > 2 && title.includes(w)) score += 1;
    return { ...s, score };
  })
    .filter((s) => s.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** A starting board by its title (as BeeZilla offered it) or id. */
export function startingBoardByName(name: string): StartingBoard | null {
  const n = String(name || "").toLowerCase().replace(/[“”"]/g, "").trim();
  if (!n) return null;
  return STARTING_BOARDS.find((s) => s.id === n || s.title.toLowerCase() === n) ?? null;
}
