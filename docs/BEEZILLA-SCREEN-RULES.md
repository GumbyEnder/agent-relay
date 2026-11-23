# BeeZilla screen rules

Updated 2026-11-23. Every change to a BeeZilla screen is checked against this page.
It joins three sources: the owner's own words about BeeZilla, the interface lessons
from the owner's games (Unbearable, Gone Dark / Cozy Driver, Mech Arena), and Miro's
standard ways of working, which people already know.

## Critical: everything moves to the Idea Board

Owner, 2026-11-20: "Everything on this website has got to be movable to the
whiteboard. That's so poor that you can list it as a critical design principle."

1. Anything a person can see as a thing (a picture, a song, a 3D model, a document,
   an Inspiration card, an idea, a search result, a conversation in History, a
   recipe, a piece of work, a link, words they select, a file from their computer)
   can be dragged onto the Idea Board, from every page.
2. It shows that it moves: the grabbing hand on hover (`cursor: grab`, `grabbing`
   while held), never only the pointing finger. Buttons on it (open, similar, ask)
   keep the pointer.
3. It shows where it goes: while anything is dragged, the drop strip at the top of
   the window says "Drop here to put it on your Idea Board", whether the board is
   open, folded or scrolled away. Pressing an Inspiration card brings the strip up
   before you move, and clicking the strip puts the card there without dragging.
4. A new kind of thing on a page is not finished until it can be dragged to the
   board: give it a drag payload (`application/x-beezilla-card`, or a
   `data-bz-card` attribute, or a plain link or picture) and check it lands.

## The website's header, on every page

Owner, 2026-11-20: "Bezilla's talk button should always be at the top. There isn't any
other place there. Everything lives under there. What you see as a talk area is
actually just the header of the entire website. That's why we can fold it away to give
room to the rest of the website. The URL bar and menu of the website lives below the
talk area." Reference zMWSgG0.

1. Top to bottom on every page (Talk, Library, Sketch, Music studio, …): the face and
   name, Talk to BeeZilla, the search or web address with its QR code and copy button,
   then the row of places. The page you are on opens under that row. No menu at the
   top of any page.
2. One element, `#bzHead`, kept alive by the page shell (nav.js) across pages: talking
   on Sketch opens the board above Sketch, and Sketch stays where it is.
3. The row of places is one long row, no More menu: Inspiration, History, Library,
   Memory, Experts, Recipes, Sketch, Music studio, What BeeZilla can do, Honey,
   Publish. About a word's width between labels; it wraps, it never scrolls.
4. Each visit opens on a blank page: a new conversation, the board folded and empty,
   Inspiration under the row. The board opens when the person talks, sends, or puts
   something on it. Older conversations are one click away in History.
5. Talking controls sit on the Talk bar (the paper clip, privacy); New conversation is
   on the board and in History; personal settings (your AI key) are behind the gear.
6. Tooltips are large and sit beside the thing, never under the pointer.

## The owner's picture of the Talk page

Owner, 2026-11-18, in order of the page:

1. "Take up the whole width of the screen." Full width, 24px side gutters (16px on a phone).
2. The face top-left, beside the name. It is the real brand art (the revision6
   expressions in `public/buzzy/brand`), switched by what BeeZilla is doing. Never a
   face drawn in code, never a blank or "apathetic" default, no blinking.
3. "A single button you push called Talk to BeeZilla. With a single line chat bubble…
   above everything else." That button is the voice switch; there is no other.
4. "When you start talking to it, it expands the whiteboard and puts the Talk to
   BeeZilla thing in the whiteboard." The board (named the Idea Board since CR-4) is
   distinct from the page: a slate surface with a fine grain.
5. "The moment it reads the agent.md, it puts the agent.md on the whiteboard… draws a
   line from the agent.md to the skill, and the next skill… so that you can edit the
   process." Every step the agent takes is a card, drawn as it happens.
6. "The search bar is underneath… it searches both inspiration and your own stuff."
   One search. Pictures show as pictures, music always with a waveform.
7. "Put the top menu below everything else." The places sit under the search, never
   on top (2026-11-20: one long row, no More).
8. "We don't need to have a difference between chat and work." One bar, one
   conversation. BeeZilla asks about the end result before building something big,
   points out what already exists, and cuts to the chase when asked.

## The Zilla agents, down the left of every page

Owner, 2026-11-21 (agents.js, agents.css; the server side is src/lib/buzzy/agents.ts):

1. A strip of faces is fixed to the left edge of every page that has the header, and the
   whole page moves over to make room (`html.bz-has-agents`, `--bzag-w`). The Zillas are
   pictures (`public/buzzy/zillas`), never drawn in code. BeeZilla (the bee) is first, then
   the person's agents, then a plus. A new account starts with one agent, the bunny, grey.
2. An agent has a name by default, a colour and a size. Its first job is given in Talk:
   pressing the plus or the grey one opens Talk as that agent, with the Idea Board open and
   the Talk button in the agent's colour, and it asks "What role do you want me to play?".
   The answer becomes its job ("helps with to-do list") and its face: an emoji for the job,
   ringed in its colour, with its Zilla in the corner. BeeZilla keeps its own face.
3. Pressing the bare strip (or the button at its foot) opens it into a sidebar: each name in
   small type, and under it what that agent helps with. It scrolls (hundreds of agents), and
   its right edge pulls it wider or narrower.
4. Every agent can be dragged onto the Idea Board (it lands as a picture card with its name
   and job), like everything else on the site.
5. Only Esc or the X closes the edit dialog (the site's rule: nothing closes on a click outside
   it); pulling its corner resizes it.
6. On a phone the strip is a drawer: a small tab at the left edge opens it, and only its X or
   Esc closes it.
7. More Zillas arrive as files: a picture named `<creature>.webp` (and `<creature>-<colour>.webp`
   for each colour) in `public/buzzy/zillas`, and one line in the roster in agents.ts. The
   colour versions there now are stand-ins made from the owner's starter picture
   (`scripts/zilla-art.py`); a real picture takes a stand-in's place by using its file name.

## Rules from the games

Each rule is a lesson the owner taught on a game; the quote is theirs.

1. One thing at a time, and the first action is the biggest thing on the screen.
   "What we need is simplification. One thing at a time."
2. Six or fewer things in the first view; more is a bug.
   "There's so many things on my screen, it's just horrible."
3. Nothing covers anything else. "Every part of the UI covers up other parts of the UI."
   The Talk page test (`e2e`) checks this: every board control is the element under
   its own centre.
4. Pop-ups and panels are capped in size, kept off the middle, and every one has a
   visible way out. "We need an 'X' button or an 'Escape' or 'Remove' button."
5. A greyed-out or refused control says why and what to do instead.
6. Never hide a choice behind a key nobody knows. Every shortcut is also a button or
   a label, and the shortcut list is one click away (F1, or the keyboard button by
   the zoom).
7. Icons must read as what they are and draw on every system: inline SVG, not emoji.
   "emoji or symbol does not show on win 10 btw at all"
8. Art and animation look made, not drawn in code.
   "rather than properly animating, you interpolate between a couple of images"
9. Copy talks to the customer about their work, never about our rules ("no AI slop").
10. Text is calm: no flicker, nothing oversized.
11. Show a value only once the person has it; no "0 of 0" counters.
12. Ask before anything spends money or makes something public.
13. Keep what the owner liked; change only what they asked.

## Miro's ways, used by default

From about 550 searches on Miro and node-based AI canvases (2026-11-18).

1. Corners, not clutter: tools in a slim column on the left; zoom, fit and the
   shortcut list bottom-right; the conversation on the right where nothing covers it.
2. Moving around: Space-drag, middle-drag, the Hand tool (H) or a two-finger scroll
   pans; pinch or Ctrl/⌘ + scroll zooms at the cursor. Alt/Option + 1 fits
   everything, Alt/Option + 2 zooms to the selection, Ctrl/⌘ + 0 is 100%.
3. Selecting: click, Shift-click to add, drag on empty board to box-select everything
   the box touches, Ctrl/⌘ + A for all, Esc for none.
4. A small floating bar over a selection holds what can be done with it — here
   Create recipe and Remove — and hides while you drag so it never blocks a neighbour.
5. Single-letter tools: V select, H hand (a thumb and four fingers), N note, plus
   BeeZilla's own A agent.md, K skill, E end result (what you want at the end; it was
   called "output", which said nothing), U upload. Undo/redo, duplicate (Ctrl/⌘ + D),
   arrow-key nudge.
6. Connect by dragging from a card's handle to another card; lines are curved.
7. A template comes from a selection ("Save as template"); in BeeZilla that is
   Create recipe, and Recipes runs it or puts it back on the board to change.
8. From node canvases (Freepik/Magnific Spaces, Flora, n8n): each step shows its own
   state while it runs; a saved chain runs again with new input; failures say why.

## Before you ship a screen

Answer yes to each, or fix it:

1. Is Talk to BeeZilla the one obvious first action?
2. Are six or fewer things visible before you scroll?
3. Does nothing cover anything else, on a laptop and at 390px wide?
4. Does every panel have a visible close or fold?
5. Does every key shortcut also have a button or a label?
6. Are all icons SVG, and is every face a real brand expression?
7. Does music show a waveform wherever it appears?
8. Is the header (Talk to BeeZilla, the search, the row of places) on top of this
   page, with nothing above it but the face and name?
9. Can every thing on this page be dragged onto the Idea Board, with the grabbing
   hand on hover?
10. Does a fresh visit open folded, on a blank page?
