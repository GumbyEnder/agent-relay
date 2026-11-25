# The Idea Board's "More" nodes: API use and Browser use

Owner, 2026-11-21: "On Beezilla, you should be able to add a node and connect nodes. But add
a node under more for API use and add another one for browser use. And you should be able to
record yourself using the browser in order to accomplish the task at hand. But the browser it
pulls up should be via a non-residential IP, so you can see it as the AI would see it."

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

This version does **not** give the model a tool to run a node by itself. Tools are offered only
on a deliverable turn (`server.ts`), and running a node means calls and clicks that leave
BeeZilla: that wants the approval design in `TOOL-AND-BROWSER-PLAN.md` (D4, B3) first.

## Where the browser runs, and why that is the point

The server browser is **not** the person's computer. Its address is a data centre's, the same
kind the AI's page reader has (`browser.ts`, Hyperbrowser, no proxy). The window says where it
goes out from — it asks the browser itself, from a blank page, then looks the address up — and
says plainly when the address looks like a home or office connection instead.

Providers (`src/lib/buzzy/remoteBrowser.ts`):

| | set | what it is |
|---|---|---|
| `hyperbrowser` | `BZ_HYPERBROWSER_KEY` | a fresh cloud session per recording, `useProxy: false`, stopped on close |
| `cdp` | `BZ_BROWSER_CDP_URL` | a browser of your own that exposes a DevTools address (not one page's address). Each person gets a browser context of their own, so nobody opens it already signed in as someone else |

`BZ_BROWSER_PROVIDER` picks one when both are set; hyperbrowser wins otherwise. With neither set the
window says the server browser isn't set up here.

The Hyperbrowser calls follow its documented session API (`POST /session` → `id`, `wsEndpoint`;
`PUT /session/<id>/stop`) and are exercised against a stand-in for it
(`scripts/probe-remote-browser.ts`). **They have not been run against the live service**, which
needs a key: run that probe's first section with `BZ_BROWSER_PROVIDER=hyperbrowser` and a key to
check it once on a deployment.

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
  page's own. A link that opens a new window opens in the same one. Downloads are refused, and so
  are `file:`, `ftp:` and `chrome:` addresses.

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
- BeeZilla running a node itself (see above).
- Keys kept for BeeZilla to use later: a sealed per-account store like `userKeys.ts`.
- Typing with an input method: a finished composition is passed on as text, but not the steps of it.
- File choosers and downloads in the server browser.
- A cloud browser can't reach an address on the person's own computer; paste a public address.
