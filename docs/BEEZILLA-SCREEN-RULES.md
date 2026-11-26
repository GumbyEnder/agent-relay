# BeeZilla screen rules

Updated 2026-11-23. Every change to a BeeZilla screen is checked against this page.
It joins three sources: the owner's own words about BeeZilla, the interface lessons
from the owner's games (Unbearable, Gone Dark / Cozy Driver, Mech Arena), and Miro's
standard ways of working, which people already know.

## Critical: findable, logical, and yours (the design philosophy)

Owner, 2026-11-23: "I strongly believe that we should be making the user interface as clear to
understand as possible, using colors and shapes to help ground people's thinking and where they
are in the greater tree of knowledge… Think the difference between Mac and Windows. Mac abstracts
everything. Windows gives you full control… The abstractions are useful for quick mental
shortcuts, but you need to be able to just understand it logically, step by step as well,
everything."

1. One tree, one address for everything. Everything BeeZilla and the agents keep has a place in
   the brain (`brain/knowledge`, `brain/systems`, `brain/assets`, see "The brain" below), and the
   person can always see where something is: its full address (`brain/knowledge/programming`)
   and a breadcrumb that starts at `brain`, where every part takes you back up. Nothing is
   findable only by search or only by knowing a trick.
2. A clear hierarchy, A to Z. A level lists its folders and things A to Z (a "Newest" order is
   one press away, never the only one). A thing has one home; a skill, which belongs to no bot,
   is listed under each use it has and says where else it is listed.
3. Colours and shapes say where you are, and mean the same everywhere. Each part of the brain has
   one colour and one shape: brain a pink hexagon, knowledge a blue circle, systems a teal square,
   assets a violet triangle. A folder wears its branch's colour and shape in the tree, the
   breadcrumb, an agent's panel and a chip. The agent you are talking to colours the interface
   (its Talk button, the open place in the row, links and focus rings: Code Monkey is #B8591F).
   Fixed meanings never change colour: the privacy modes stay green, yellow and red, and a warning
   stays yellow, whoever is talking.
4. Shortcuts are welcome; a shortcut alone is not. A summary, a lit folder or "Works here" is a
   quick way in, and the same thing can always be reached and understood step by step from
   `brain`. Explain what the automatic parts do, in a sentence, where they act (the tidy says when
   it ran and what it does).
5. The person is in control of their environment. What the person can see they can change: move a
   memory, conversation, file or recipe; make and remove folders; give an agent another name,
   picture, colour, job or folders; tidy now. What they decide is never undone by the automatic
   parts (the tidy never moves what they placed, a starter agent they removed never comes back).

Before you ship a screen, also check: can everything on it be found step by step from `brain`,
with its address shown and a breadcrumb back? Does every folder wear its branch's colour and
shape, and does the interface wear the colour of the agent being talked to, with the modes
keeping theirs?

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

## Critical: nothing closes on a click outside it

Owner, 2026-11-21: "They would have to X out to lose their progress, not just click to
the side. That's a fundamental principle of our design: no click-outside-to-close.
Escape key or an X closes anything that opens up."

1. Anything that opens (a dialog, a pop-up, a panel, a drawer, a sidebar, a window of
   chats, a viewer) closes only with its own X (or a button that says Close or Cancel)
   or with Esc. A click, a tap or a press anywhere else leaves it open and keeps what was
   typed or chosen in it, so progress is only ever lost on purpose.
2. So there is never a click handler on a backdrop that closes the box, and never a
   document-level "click outside" listener that closes or minimises a panel. Choosing
   something inside a menu closes the menu (that is an act on it), and a tooltip goes away
   by itself because it holds nothing. The plain menus that remain (the account menu: nothing
   can be typed in it) also close on a press away; each is listed, with its reason, in
   `scripts/test-no-outside-close.mjs`, and a new one needs a reason there.
3. Every one has a visible way out: an X or a button named Close or Cancel (36px or more),
   and it answers Esc wherever focus is. With more than one open, Esc closes the top-most.
4. A new pop-up is not finished until a test presses outside it and finds it still open.
   `scripts/test-no-outside-close.mjs` reads the source for backdrop and outside-press
   closers (it runs in `test:ci`); `scripts/probe-no-outside-close.mjs` presses outside the
   real ones in a browser, at 360/390/430/1366, and measures each exit control — settings X,
   privacy X, the key dialog's `.ob-x`, and the two recipe dialogs' `Cancel`/`Close` — for
   being wholly inside the viewport, actually hittable at its centre, and closing on a real
   click. A recipe dialog legitimately has no X; `Cancel`/`Close` satisfies this rule.

## Critical: boxes and panels can be resized

Owner, 2026-11-22: boxes and panels (conversation history and the like) can be resized by
grabbing a side or a corner. A panel that sits beside the page is pulled by its inner edge;
a dialog by its corner (a native `resize: both`, or a handle). Nothing is capped so small,
or so large, that it can no longer be used.

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
7. The QR code and Copy page link SHARE the page, so both ask first (owner, 2026-11-21:
   "you have to know that you're going to open this up… a little pop-up to say yes and
   confirm… to anyone with a link or searching it via the internet… a sub option that's
   small that says block searches by default"). `public/buzzy/page-share.js` is that
   window: it lists what becomes public (from the server, with numbers), what is left
   out, and the small "Block searches" tick, ticked until it is unticked. Nothing is made
   until "Yes, share this page"; while the tick is on, the shared page (`/buzzy/p/<token>`)
   is served `X-Robots-Tag: noindex…` and a robots meta tag. Only Open shares. If a share
   ever exposes more than the window lists, change the window (`includesOf`,
   `NOT_INCLUDED` in `src/lib/buzzy/pageShare.ts`) in the same change.

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
7. Colonies (owner: "you can drop it on another agent, just like you can drop a Discord server
   on another Discord server"): dragging one agent onto the middle of another makes a colony
   and asks for its name and purpose, with grey examples chosen from what the agents inside
   help with ("These agents are dedicated to my real estate business", "…my personal
   productivity", "…fun and hobbies"). Onto a colony adds to it; between two rows reorders; out
   to a gap leaves. A colony opens and closes like a folder and can be ungrouped (its agents
   stay). Dragging is never the only way: an agent's Edit window has a Colony choice.
8. The Hive (owner: "When it scrolls above Bzilla, you see something called Hive… you can see
   your agents talking to each other to get things done, agent-to-agent chat, and observe it
   happening in the background: a window of chats that say 'Bunnyzilla asked Bzilla for
   this.'"): the first row of the strip, above BeeZilla and scrolled out of sight; a small
   "Hive" label at the top of the strip says it is there and scrolls to it. It opens a window
   beside the strip (not a modal: the page behind stays usable) that lists who asked whom and
   what came back, and updates while it is open. Only Esc or its X closes it; its corner
   resizes it. BeeZilla manages the agents and can talk across all of them, so the asking
   goes through her: an agent calls ask_bzilla, and she calls ask_agent.
9. More Zillas arrive as files: a picture named `<creature>.webp` (and `<creature>-<colour>.webp`
   for each colour) in `public/buzzy/zillas`, and one line in the roster in agents.ts. The
   colour versions there now are stand-ins made from the owner's starter picture
   (`scripts/zilla-art.py`); a real picture takes a stand-in's place by using its file name.
10. Code Monkey (owner, 2026-11-23: "By default, there's going to be this monkey on the left side
    underneath the Bzilla thing… this is your coding monkey… that color should be hex B8591F"):
    every account starts with it right under BeeZilla, ready to talk to (its job is coding), in
    the owner's monkey picture, working in `brain/knowledge/programming`,
    `brain/knowledge/web-design` and the programming and web design skills. It is an agent like
    any other: rename it, recolour it, change its job or folders, or remove it (it stays removed).
    A deployment can leave it out with `BZ_STARTER_AGENTS=bunny`.
11. Pressing an agent (or BeeZilla) opens its panel beside the strip (owner: "Each time you click
    one, there's a list of folders that is highlighted and a list of folders that is grayed out.
    The highlighted ones are on top. Those are the domains that the bot in question often operates
    from."): its folders of the brain, lit on top (its own folders and those it has talked about
    most, most first), the rest of the brain grey below; then its History, the recent conversations
    with it. The Talk button says "Talk to <its name>" and the interface takes its colour. Like
    Discord: servers down the left, their channels beside them. The page moves over for the panel;
    only Esc or its X closes it (Esc on a folder steps back to the agent first); its right edge
    makes it wider or narrower; on a phone it covers the page until closed.
12. Pressing a folder (owner: "it will highlight many of the bots that work frequently in that
    folder. It'll also give you a list of recent sessions related to that folder… When you click on
    a folder, you see the entire folder tree. But it switches to the memory tab."): the bots that
    work there light up in the strip and the others step back; the panel lists them ("Works here")
    and the recent conversations about the folder; and the Memory tab opens at that folder, with the
    whole tree and the breadcrumb back to brain. A folder chosen in the Memory tab does the same.
13. History, while you talk to one of your agents, lists its conversations first, with "Show
    everything" one press away.
14. BeeZilla makes agents too (owner: "Bzilla is an orchestrator agent that can create new
    sub-agents itself, not only the human, give them defined domains of expertise"): ask her for
    a new agent and she makes it (the make_agent tool, orchestrate.ts) with a name, a job and the
    folders it works in. It appears in the strip at once and the Hive notes it. She is offered the
    tool only when the person asks for an agent, and may not say she made one unless she did.

## The brain: one tree for everything that is kept

Owner, 2026-11-23: "whenever somebody clicks a folder, they should also see a /brain at the very
core, which they can breadcrumb back to. When they breadcrumb back to it, it shows them their
memories… At the core, it'll be like, instead of /C, it'll be like brain." The Memory tab (and the
full Memory page) is a plain explorer of it (public/buzzy/brain.js; the server is
src/lib/buzzy/brain.ts, the map src/lib/buzzy/brainMap.ts).

1. `brain/knowledge`: what has been learned. Remembered decisions and conversations, filed by
   subject (programming, web design, home, money, travel… and general), each under the job it
   came from when a subject grows big.
2. `brain/systems`: everything that isn't knowledge. `bots/<bot>` holds each bot's agent.md (who it
   is, its job, its folders) and its picture (changed from its Edit window). `skills/<use>` holds
   BeeZilla's skills by what they are useful for (programming, web design, research, writing…):
   a skill belongs to no bot, any of them can use it, and it is listed under every use it has.
   `recipes` holds the recipes made on the Idea Board.
3. `brain/assets`: media to use again, so nothing is made twice: pictures, videos, music and
   sounds, 3D models, other files.
4. `brain` itself shows the three branches and the person's memories, newest first.
5. The tidy ("the fastest path", on a cadence): everything goes in the folder for its subject or
   kind; a folder with more than 12 loose things is split by the job they came from wherever three
   or more share one, and a split that shrinks back is undone. It runs once a day, or sooner once
   20 new things are waiting, when the brain is next opened (or at once with "Tidy now"). New
   things are placed the moment they are first seen and stay put until the next tidy, so nothing
   moves while the person is looking. What the person moved, and folders they made, are never
   touched.
6. Every folder and thing can be dragged onto the Idea Board. Moving, making a folder and
   forgetting a memory are in the explorer; dialogs close only with Esc or their X.

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
14. The three privacy modes keep their colours wherever a mode shows (the Talk bar
    button, its picker, the pill, hover, keyboard focus, dark and light): Open is
    green, Advocate is yellow, Lockdown is red. "Open should be green, advocate
    should be yellow, lockdown should be red… be careful with that" (owner,
    2026-11-21). `npm run test:mode-colors` holds the stylesheet to it and
    `scripts/probe-mode-colors.mjs` draws it in a real browser.

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

## Boxes and panels can be made bigger or smaller

Owner, 2026-11-22: "If I have a box like the conversation history, I could just grab the
side or the corner and grow the size of that so I can see it bigger if I want to. Make it
so." A design rule from now on, next to the pop-up rule that nothing closes on a click
outside it (only Esc or an X closes anything): every box or panel that holds something worth
reading can be dragged by a side or a corner. `public/buzzy/resize.js` does it, on every
page.

1. Any side or corner. The pointer says so, a line lights along the edge about to be
   grabbed, and the corner you can Tab to wears a small grip. A box is pulled by the sides
   that make sense for where it sits: a card on the Idea Board by all four sides and
   corners; a panel hanging from a corner (Feedback from the top right, History from the
   bottom right) by the sides that face into the page, so the corner it hangs from never
   moves.
2. The size a box opens at is where it starts, not a cap. Pull it past that, up to the
   window's edge (or the edge of the panel it sits in). It is never so small it can't be
   used (260 x 220 for the conversation) and never so big it leaves the window.
3. At any zoom. A card on the board changes by what the pointer moved, not by what the
   board's zoom turned it into.
4. Dragging is never the only way. Tab to the corner: the arrow keys change the size
   (Shift for bigger steps), Home puts it back. A double-click on a side or the corner
   puts it back. Esc, while dragging, takes the drag back, and that Esc is the drag's: it
   closes nothing.
5. It is remembered. The conversation card keeps its size in the card (saved with the
   board to the account, and in undo); the Idea Board's height and the panels' sizes are
   kept in this browser. A panel that folds up (Feedback) is its small self again and
   gets its size back when it unfolds.
6. A drag never closes, moves or selects anything else, and one that ends somewhere
   outside the box leaves it open.
7. The boxes today: the conversation (the card on the Idea Board), the Idea Board's height
   (by its bottom edge), History, the step editor, Feedback. Menus, tooltips and small
   forms (the AI key, the purchase confirmation, the privacy picker) are not boxes people
   need bigger; the rule is for what holds something to read or write. The 360 x 480 the
   conversation opens at, like the caps in the rules from the games, is where it starts.
8. A new box joins by saying so, with no code of its own:
   `data-bz-resize="e s se" data-bz-resize-anchor="start" data-bz-resize-key="agents"`
   (the sides to pull; how it sits: start = held by its left and top, end = by its right and
   bottom, center; the name its size is kept under; the list is at the top of resize.js).
   Whoever shows the box inside should let it take the room (flex: 1 on what holds the
   words). It is not finished until `scripts/probe-resizable-boxes.mjs` pulls it; copy one
   of its blocks. `scripts/test-resizable-boxes.ts` holds the sums and the manners (it runs
   in `test:ci`).

## Before you ship a screen

Answer yes to each, or fix it:

1. Is Talk to BeeZilla the one obvious first action?
2. Are six or fewer things visible before you scroll?
3. Does nothing cover anything else, on a laptop and at 390px wide?
4. Does every panel have a visible close or fold, and can it be dragged bigger or smaller
   by a side or a corner?
5. Does every key shortcut also have a button or a label?
6. Are all icons SVG, and is every face a real brand expression?
7. Does music show a waveform wherever it appears?
8. Is the header (Talk to BeeZilla, the search, the row of places) on top of this
   page, with nothing above it but the face and name?
9. Can every thing on this page be dragged onto the Idea Board, with the grabbing
   hand on hover?
10. Does a fresh visit open folded, on a blank page?
11. Does a mode (Open, Advocate, Lockdown) show in its own colour, green, yellow, red,
    in every state?
12. Does everything that opens close only with its own X, Close or Esc, and keep what was
    typed when the page around it is pressed?
13. Can every box and panel be resized by a side or a corner?
