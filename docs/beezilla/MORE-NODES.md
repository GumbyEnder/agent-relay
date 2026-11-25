# The Idea Board's "More" nodes: API use and Browser use (the globe)

Owner, 2026-11-21: "On Beezilla, you should be able to add a node and connect nodes. But add
a node under more for API use and add another one for browser use. And you should be able to
record yourself using the browser in order to accomplish the task at hand. But the browser it
pulls up should be via a non-residential IP, so you can see it as the AI would see it."

Owner, 2026-11-23: "make it so that browser use absolutely works for Bzilla. So it's able to use
its own browser to automate and complete tasks on your behalf as per your commands to it. You need
to be able to record the steps yourself in the given browser using its IP address so that you have
to follow the steps exactly. It should be something where that's something you could drag into the
whiteboard. It should look like a globe icon… that globe icon means that you can begin to connect a
skill to a browser and say, do this specifically, or follow this recording specifically. But mostly,
it's just going to be orchestrated via Bzilla saying, OK, when you get to that step, go to [the
site] and… go to /create and then type in these instructions to create the sound and then download
the sound and send it elsewhere."

## The globe: BeeZilla's own browser, doing the job

- **The globe** is in the board's tools (key **B**). Drag it onto the board, or press it and click
  where it goes; it is also under More → Browser use. A browser node is a card with a globe on it.
- A node does one of two things (tabs in its window):
  - **Do this** — the job in words ("Go to mureka.ai/create, type the song idea, press Create, wait
    for the song, then download it"). BeeZilla does it itself in its browser, one step at a time
    (`browserAgent.ts`): it looks at the page (the things on it, numbered, and its words), asks the
    model for the next thing to do, does it, and so on until it is done or needs the person.
  - **Follow a recording** — Record once in BeeZilla's browser; every step is followed exactly. A typed
    step can be **Filled in each time** (a blank): BeeZilla types the words of the moment there (the
    day's song idea) instead of what was recorded; run from the window, **Words for this run** asks
    for them. A step waits for its button (a Download that
    appears when the song is ready) for about twice as long as the person waited when recording.
- **Run it now** runs it while the window shows the browser working, step by step; **Stop** hands the
  browser back to the person. A job that worked from words can be **kept as the recording**: what
  BeeZilla did becomes the steps, the box it typed the words of the moment into becomes a blank.
- **Downloads** go to the person's Library (`browserFiles.ts`, `remoteBrowser.ts` downloads): the
  window lists them (and plays a sound), the card links them, and on the board the file appears beside
  the globe. Each is checked first: its name made safe, its type taken from its first bytes, anything
  that could run as a page on BeeZilla's address (HTML, SVG…) kept as plain bytes to download.
- **Staying signed in**: the person signs in to a site once, themselves, in the window (BeeZilla never
  types a password). BeeZilla's browser remembers it — a cloud browser keeps a profile of the person's
  own on the provider (found again by a hashed name; nothing is stored here), a browser of your own
  keeps the cookies in this server's memory for 12 hours — until **Forget sign-ins**.
- **Run by BeeZilla**: joined to a step (its dot onto the step: "use this here"), the globe is listed
  under that step in what BeeZilla is told, with its id. When the work reaches it — "do it", "carry on",
  the composer's Do it — BeeZilla calls its tool **use_browser** with that id and the words of the
  moment, and the globe's card shows it working, then how it went. A job can also be asked for in words
  alone ("go to mureka.ai and make a song about bees"): it becomes a globe on the board too. A clear
  command ("use your browser to…", "go to … and make…", "do it" with a globe on the board) always calls
  the tool (`browserCommand`); one turn can run one globe after another (make the song, then post it),
  each round seeing the last one's result.
- **Said to BeeZilla**: "when you get to the make the song step, go to mureka.ai/create, type the song
  idea, press Create and download it" puts a globe with that job, in those words, on the board, joined
  to that step (`boardPilot.ts` browserAtStep). "That step" is the step selected on the board.

### What BeeZilla never does in its browser (in code, whatever the model asks)

- It never types into a password, card or one-time-code box (a code sent to you, a card or bank
  number — not a zip or promo code); it stops and says to sign in yourself. The words go only where the
  cursor really is, and only if that is the box it meant: a page that lays a password box over a plain
  one, or moves the cursor into one, gets nothing.
- It never presses a button that pays, buys, subscribes, upgrades, starts a trial, adds a card, or
  deletes or closes the account (`personOnly`, `MONEY_WORDS`, `ACCOUNT_WORDS`): it stops before it and
  says it is the person's to press. That holds for recordings followed exactly, for Enter or Space
  (what the cursor is on, and a form's own send button), for a button that is only a picture ("Buy
  now" in its picture's words), and for whatever a click would really land on when something covers
  the thing it meant.
- It opens no private or internal address (the checks below). The browser's own download is checked
  hop by hop (a download is a page load to the browser), and a file whose final address is inside is
  not kept, not even from the browser's own copy.
- It opens by address only the sites the job's own words name (or, when they name none, the first one
  it went to before reading any page): a page's words can't send it to another site with what it saw.
  Links on a page are still followed by clicking.
- It hands a website only files it downloaded in that job (or earlier in the same turn), or a file
  named whole in what the owner said or on their board's own cards — never one a website's words named.
- After a tool has answered in a turn, a website's words are in the conversation: from then on only
  the board's own globes can run, and nothing that reads or searches the web is offered.
- The website's words reach the model labelled as the website's (data, never instructions), between
  quote marks it can't close; the only instructions are the job's own words. Where a run ended is kept
  on the card without anything that looks like a key.
- Limits: a job may do 40 things and take 5 minutes (`BZ_BROWSER_TASK_ACTIONS`,
  `BZ_BROWSER_TASK_SECONDS`), one step's thinking 90 seconds (`BZ_BROWSER_STEP_SECONDS`); the same
  thing tried again and again stops it; Stop stops it. A job going on is never closed as idle.
- Ads and their pop-ups are blocked (the cloud browser's own blocker; a short list of ad networks on a
  browser of your own; `BZ_BROWSER_ADBLOCK=0` turns it off): on a real text-to-speech site a
  full-height ad sat over the Download button. A pop-up that is the page's own (a dialog) is named to
  the model to deal with; a see-through layer over a button is clicked through.
- A "Download" that opens the file itself as the page (a song or a PDF in a new tab) is kept like a
  download.

### A long job and the conversation

A turn waits for the job up to four minutes (`BZ_BROWSER_TURN_WAIT_SECONDS`, 240): a connection held
open longer is cut on the way (Railway's edge). Past that, BeeZilla says it is still going, and the job
finishes on its own — its files land in the Library, and the board picks up how it ended
(`GET /api/buzzy/nodes/browser` → `lastRun`). While it works, the turn's stream sends a step every few
seconds and a keep-alive every 15 seconds, and Talk waits as long as the browser is busy (up to 15
minutes). A song it downloads plays in BeeZilla's reply.

## What a person sees

- **More** (the dots at the bottom of the tools on the left, or the **M** key) opens a short
  list: **API use** and **Browser use**. It closes with Esc, its Close, or a choice — never on a
  click outside it.
- Choosing one puts a card on the board and opens its window. A node is an ordinary card: drag
  it, drag its dot onto a step to join it (that means "use this here"), duplicate it, undo it,
  put it in an area or a recipe.
- **API use.** Method, address, headers, keys, a body, and what it is for. **Try it** makes the
  call from BeeZilla's server (so the answer is the one BeeZilla itself would get) and keeps
  the status, time and the start of the answer on the card.
- **Browser use.** **Record** opens a real browser on a server, shown in the window as pictures
  you can click and type into. Every click, line typed, key and scroll becomes a step in plain
  words. **Watch it run** plays the steps back. **Just look** opens the browser without
  recording, to see a page the way the AI would.
- The window can be resized by its left edge, top edge or top-left corner (the size is
  remembered on that computer). Nothing in it closes on a click outside it.

## What BeeZilla is told

`whiteboard.js` `compile()` writes a node into the board text sent with the next message, in
words: an API node as its method, address, purpose, headers, the name of any key it needs and the
start of its last answer; a browser node as its numbered steps (what was typed included, a
password never) and how the last play ended. Joined to a step it is listed under that step;
alone, under "Also on the board". Words that came from outside — an API's answer, a website's
button names — are labelled as such and are never instructions (D5 in
`TOOL-AND-BROWSER-PLAN.md`).

A browser node is told with its id and either its job in words or its steps (a blank named, with
the words it was recorded with), and BeeZilla runs it with `use_browser` (above). The tool is offered
only on a turn that is about a website or the board's globes (`browserRun.ts` wantsBrowser): a tool
list turns off the streaming of an ordinary reply. The API node is still only told, not run.

## Where the browser runs, and why that is the point

The server browser is **not** the person's computer. Its address is a data centre's, the same
kind the AI's page reader has (`browser.ts`, Hyperbrowser, no proxy). The window says where it
goes out from — it asks the browser itself, from a blank page, then looks the address up — and
says plainly when the address looks like a home or office connection instead.

Providers (`src/lib/buzzy/remoteBrowser.ts`):

| | set | what it is |
|---|---|---|
| `hyperbrowser` | `BZ_HYPERBROWSER_KEY` | a fresh cloud session per browser, `useProxy: false`, `saveDownloads: true`, the person's own profile (`persistChanges`), stopped on close. `BZ_HYPERBROWSER_STATIC_IP_ID` (a static IP bought on the provider) makes every browser go out from that one address |
| `cdp` | `BZ_BROWSER_CDP_URL` | a browser of your own that exposes a DevTools address (not one page's address). Each person gets a browser context of their own, so nobody opens it already signed in as someone else. `BZ_BROWSER_DOWNLOAD_DIR`: a folder it shares with this server, for downloads it can't hand over twice |

`BZ_BROWSER_PROVIDER` picks one when both are set; hyperbrowser wins otherwise. With neither set the
window says the server browser isn't set up here.

The Hyperbrowser calls follow its documented API (docs.hyperbrowser.ai, read 2026-11-23: `POST
/session` → `id`, `wsEndpoint`; `PUT /session/<id>/stop`; `GET /profiles?name=`, `POST /profile`,
`DELETE /profile/<id>`; `GET /session/<id>/downloads-url` → `status`, `downloadsUrl`) and are
exercised against a stand-in for it (`scripts/probe-remote-browser.ts`, `scripts/probe-browser-globe.ts`
part 7). **They have not been run against the live service**, which needs a key.

## How it works

```
person's browser ── POST /api/buzzy/nodes/browser/<id>/input  ─▶  server ── CDP over WebSocket ─▶ the browser
                 ◀─ GET  /api/buzzy/nodes/browser/<id>/stream (SSE: frames, steps, where) ─┘
```

- `cdp.ts` is a small DevTools client on the runtime's own `WebSocket` (Node 22+); no dependency.
- Pictures are `Page.startScreencast` JPEGs, at most about eight a second, dropped (never queued)
  for a slow connection.
- Input is passed on as real mouse and key events. The steps are written down from that input,
  by asking the page what is under the pointer (its label, role, a selector). A page can't add a
  step: nothing it runs is trusted, and what it says is trimmed to plain text.
- A recording is replayed by finding each thing again — selector, then its name, then where it was —
  so a page that moved a button still works. Passwords and codes are left for the person.
- A list (`<select>`) is offered as a small menu in the window, since a screencast can't show the
  page's own. A link that opens a new window opens in the same one. `file:`, `ftp:` and `chrome:`
  addresses are refused.
- Downloads: the browser says when one starts and ends (`Browser.downloadWillBegin`/`Progress`, only
  for this person's page); the bytes are read through the browser itself (`Network.loadNetworkResource`:
  its address, its sign-ins), or — for a file the page built itself (`blob:`) — read in the page, which
  is kept from letting it go for a couple of minutes (`KEEP_BLOBS`); a link that works only once comes
  from the browser's own copy (the provider's zip, or the shared folder). 25 MB at most (the Library's
  limit).

## Safety

- Everything needs a signed-in person; a browser belongs to the one who opened it. Requests from
  another site are refused (Origin check). Lockdown turns both nodes off, and ends a browser that
  is already open at its next request after Lockdown is switched on (a window that only watches
  keeps it until the idle timeout).
- A board is saved to the account, copied into recipes and can be shared as a page, so **no secret
  is kept on it**: an API node keeps the *name* of a key, never its value (typed again for each
  try); the value of a secret word in an address (`?api_key=…`, also in recorded pages' addresses
  and links) is emptied; a secret-named key in a request body (JSON or form) is emptied; what is
  typed into a box that says it is for a password, card, code or PIN is passed to the page and
  never written down — and neither is text typed when the cursor jumped to another box by itself.
  `cleanNodeText` (`boardNodes.ts`) enforces it on the account's side whatever the page sends, and
  the card's own words (`body`) are written there from what was kept, never taken from the page.
  Not covered: a key written into the *path* of an address (a webhook URL, `/bot<TOKEN>/`) or under
  a name nobody could know is a key (`X-Honeycomb-Team`): the window says to use Keys.
- The API call is guarded like every reader here: http(s) only, a few ports, the address resolved by
  a resolver with its own 3 s timeout and connected to as checked, private/loopback/link-local/
  metadata refused on every redirect (IPv4 hidden inside IPv6 included), 12 s, 512 KB, three
  redirects. Another site never gets the keys (the headers a key was sent in are taken back out on a
  redirect to another site). A key a service echoes back (as it was, URL-encoded or JSON-escaped) is
  taken out of the answer. `BZ_API_NODE_ALLOW_PRIVATE=1` lifts the private rule for tests only.
- The server browser refuses private and internal addresses: the address bar, a played step, a link
  that opens a window, and every page a link or redirect loads (a `Fetch` interception of documents)
  are checked first. A name with a trailing dot (`localhost.`), a name with no dot (`grafana`) and a
  name that gets no answer here are refused as well (the browser's network may know them through a
  hosts file or search domains this server can't see), and names are resolved here to refuse ones
  that point inside. What this cannot do: see what a page's scripts fetch behind the scenes, tell a
  name that answers publicly now and privately a moment later (DNS rebinding), or stop the very
  first request of a window a page opens (the window is closed and followed here, but that one
  request has gone). For a hard guarantee run the browser on a network with no inside, or set
  `BZ_BROWSER_PROXY` to an egress proxy that refuses private ranges (used for each person's browser
  context on the cdp provider). `BZ_BROWSER_ALLOW_PRIVATE=1` lifts all of this for a browser run on
  your own machine for tests.
- The browser's clipboard is shared by everyone on a shared browser, so the keyboard's copy, cut and
  paste (Ctrl/⌘ + C, X, V, Shift+Delete/Insert, Ctrl+Insert) are not passed on; pasting from the
  person's own clipboard arrives as typed text.
- A page's scripts can't change what the recorder sees: the helpers that read the page (what is
  under the pointer, what a box is called, where a thing is) run in an isolated world the scripts
  can't touch, and the address and title in the window come from the browser itself. (A page can
  still dress a plain box up as something else with its looks and label: that is what the person
  sees too.) A page's words are trimmed, and its own curly quotes are taken out before BeeZilla is
  told them between quote marks. A recipe holds a node as a note that says its quoted words are the
  website's own, never as a step to follow.
- A page's question (`confirm`, `prompt`) is answered No and the person is told; an alert is closed.
- Cost: one server browser per person (opening two at once is refused), `BZ_BROWSER_MAX_SESSIONS`
  (20) in all, closed after `BZ_BROWSER_IDLE_SECONDS` (240) without input and after
  `BZ_BROWSER_SESSION_SECONDS` (1200) or the time left today, whichever is less. The seconds are
  counted against the plan every minute while it is open (`PLANS[...].browserSecondsPerDay`:
  10 / 60 / 240 minutes, in `entitlements.ts`), so a restart loses at most a minute. A flood of input is
  turned away (429; the window sends the same events again a moment later) and a browser has at
  most three windows watching it (a fourth takes the place of the oldest).
- The sessions live in one server process. With more than one copy of the server a person's
  calls must reach the same copy. Cloud sessions are stopped on close and time out on their own if
  the server dies.

## Checks

- `npm run test:browser-globe` (after `test:board-nodes` in `test:ci`): what a globe keeps, files made
  safe, a zip read, BeeZilla's next step read from a model and the page shown to it, the buttons it
  never presses, when a turn gets the tool, "when you get to that step…", what BeeZilla is told.
- `BZ_TEST_CDP=<DevTools URL> npx tsx scripts/probe-browser-globe.ts`: a job for real against a small
  make-a-sound site, with a stand-in model — signed out it stops for the person; signed in once (the
  password typed by the person), it types, presses Create, waits, downloads (over the web, and a file
  the page builds and lets go of at once); kept as a recording with a blank and followed with new
  words; a file handed to another page; Pay now, a password box and Stop; the sign-in kept for the
  next browser and kept from anyone else; the cloud provider's profile, downloads zip and forgetting.
- `BZ_PROBE_CDP=… BZ_SERVER_CDP=… node scripts/probe-browser-globe-ui.mjs` (after `npm run build`):
  the whole thing in a signed-in production build — drag the globe in, Run it now, the file in the
  Library and on the card, keep it as a recording; then in Talk, a step, "when you get to the make the
  sound step, go to …", "the sound idea is wind chimes. do it": BeeZilla runs it, the file lands on the
  board beside the globe and plays in the reply.

- `npm run test:board-nodes` (in `test:ci`): what the account keeps (and never keeps), what BeeZilla
  is told, the API call and every address it must refuse, the words for steps.
- `BZ_TEST_CDP=<DevTools URL> npx tsx scripts/probe-remote-browser.ts`: the server browser for real —
  streaming, recording, a password, a list, replay, a moved button, a new window, people kept apart,
  a page that tampers with the page's own tools, a cursor that jumps, Shift+Enter, a page's question,
  limits, private addresses refused, the cloud provider's calls.
- `node scripts/probe-board-nodes.mjs <origin>`: the whole thing in a signed-in browser on a
  production build (see the top of the file for the server settings it needs).

## Not done
- A hard network guard under the server browser (see Safety).
- A key written into an address path, or under an unusual name.
- The API node run by BeeZilla itself, and a file sent to an API (only the browser can send it on).
- A recipe holding a globe: a recipe keeps a node as a note, so a recipe run doesn't run its globes yet.
- Pages inside frames (an embedded editor, a payment box) are not seen by a job, and nor is a canvas
  app's inside; turn on `BZ_BROWSER_AGENT_VISION=1` with a model that takes pictures to give it the
  screen as well.
- Keys kept for BeeZilla to use later: a sealed per-account store like `userKeys.ts`.
- Typing with an input method: a finished composition is passed on as text, but not the steps of it.
- The person's own file chooser in the window (a job can hand a page a file; a person recording can't).
- A cloud browser can't reach an address on the person's own computer; paste a public address.
