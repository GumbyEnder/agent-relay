# Desktop ↔ web parity — what is shared, what is deliberately different

The desktop branch (`feat/local-runtime`) and `main` are the same product with two
runtimes underneath. Most divergence so far has not been a decision, it was drift —
so this file is the decision, and the parity gate should read it rather than
guessing.

## Rule

A surface is **in parity** when the desktop either runs the same code as `main`, or
has a written, deliberate difference in this file. Anything else is drift and
should fail the gate.

## Deliberately different (and why)

| Surface | Web (`main`) | Desktop | Why |
|---|---|---|---|
| Host routing — `product-hosts`, `host-router`, `lane-rules` | one deployment serves `app.devboards.ai`, `beezilla.net` and per-host rules | absent | The desktop serves exactly one origin: `127.0.0.1:<ephemeral>`. Host routing exists to disambiguate tenants on one socket; a local single-tenant runtime has nothing to disambiguate. If a desktop build ever needs a second host, revisit this. |
| Sign-in — `login.html`, popup auth server | browser popup, session cookie set by the site | `identity.json` + local owner injected as env (`BZ_LOCAL_OWNER_NAME`/`EMAIL`) | There is no browser window to open and no cookie jar to share. The desktop proves identity by holding the account's inference token; the local runtime trusts its own file. |
| Managed inference | server holds the provider key and calls it directly | short-lived capability token (`bz1.…`), spent at the gateway | The hard rule: a provider key never lands on a user's machine. |
| `/buzzy/settings` | 404 — the page needs the local bridge | present | The desktop *is* the bridge: it owns the key store, the logs and the microphone. |
| Updates | redeploy | `electron-updater` against GitHub releases | Different delivery mechanism, same guarantee: the user runs current code. |
| Art gateway flag | `BZ_CHAT_KEY` on the server | `BZ_IMAGE_VIA_GATEWAY` + token | Same capability, no key on the machine. |

## Must be identical (drift here is a bug)

- `src/lib/buzzy/toolRegistry.ts` — the tool surface the model is offered.
- `src/lib/buzzy/server.ts` — the chat loop, music/art pre-passes, and the rule that
  a reply may not claim an artifact that does not exist.
- `src/lib/buzzy/intent.ts` — what counts as a draft, a music request, an execute
  command.
- `src/lib/buzzy/entitlements.ts` + the gateway gates — plan, model allowlist,
  rolling-24h quota, revocation. A cheap desktop would be a way around billing.
- `public/buzzy/*.html` pages and the canonical nav.
- `migrations/*` up to the highest applied number; the desktop must never invent a number
  `main` has not used. The board's tables are `main`'s: `buzzy_board_recipes` comes from
  `0060_buzzy_one_board.sql`, `buzzy_whiteboards` and `buzzy_whiteboard_versions` from
  `0061_buzzy_whiteboards.sql`. This line adds no migration.

## Known open parity work

Tracked as issues, not as this document:

- #290 art/sketch surface — **now ported** (see below), keep an eye on `art.ts`.
- #291 this document (closes when the parity gate reads it).
- #292 Library card job titles — **fixed** by the assets join in 0.3.0.
- **CR-8, the nav slice (done on this branch):** the chrome is web main's chrome, not a
  lookalike. `public/buzzy/nav.js` is what beezilla.net serves (138,099 B, md5
  `0965f52ae4baccea450f276c9a2f97d4`) with one block — `DESKTOP_ABSENT`, which drops
  Orchestrate, the only place whose page is not in this tree. `public/buzzy/nav.css` is
  byte-identical to web's. `src/lib/buzzy/pages.nitro.ts` injects the sheet and the
  script into every page it serves, idempotently, and nav.js builds the row from LINKS,
  so there is one row and one owner of its order. Before: eight or ten hand-written
  anchors per page, order Talk / Capabilities / Sketch / Memory / Experts / Recipes /
  Honey Drops / Publish, `target="_blank"` on Library, literal "Sign in".
- **CR-8, the two pages the row names (done on this branch):** `public/buzzy/studio.html`
  and `public/buzzy/download.html` are web main's bytes, `chat.js` is web main's, and
  `src/lib/buzzy/studio.ts` + `studio.nitro.ts` are ported with the `/api/buzzy/studio`
  route listed before the `/api/buzzy/**` catch-all in `vite.config.ts`. Migration
  `0054_buzzy_music_edits.sql` keeps web's number (the desktop must never invent one).
  `desktop/smoke.mjs` reads the served nav.js's LINKS (minus `DESKTOP_ABSENT`) and fails
  if the order is not web's, then follows every href and fails on non-200, a page without
  the nav, or a page that never loads nav.js — so a place the row inherits from the
  website cannot 404 here unnoticed.
- **`#bzHead`, slice 1 (done on this branch):** `public/buzzy/talk.html` now carries the
  shell's header element — `#bzHead.bz-head` with the row of places (`#bzPlaces`) and the
  oneboard.css row styling — so nav.js sets `html.bz-has-head` and hides the top link row
  where it exists, as on web. The phone bar went from three rows to two: **211.6 → 166.5px
  at 390** (web 172.1; the 5.6px is the Feedback pill web has and this line does not),
  places row 4 rows, `scrollWidth == 390`, one `#bzHead` after soft navigation. At 1280 the
  bar is 76px (web 77) and the row is one line. Slice 3 lands the bar, so Talk is no longer
  named in the row (the bar is the way back, as on web).
- **`#bzHead`, slice 2a — `/api/buzzy/search-status` is real (done on this branch):** the
  route three scripts (`test-search-live`, `test-search-managed`, `test-search-reconnect`)
  and the settings/doctor bridge already asked for now answers, session-gated, in
  `src/lib/buzzy/chat.nitro.ts`:

  ```json
  {"ok":true,"available":true,"provider":"brave","needsReconnect":false}
  ```

  `available` is false when the managed session has expired and `needsReconnect` is then
  true — "your session lapsed" must never read as "search is off", or a signed-in owner
  goes hunting for a Brave key they were never meant to need. The provider is named; the
  key never is (all three suites assert the payload does not contain the key). Proven on
  the built runtime: managed 7/7 PASS, reconnect 13/13 PASS, live 4/4 PASS + 1 SKIP (no
  live key in this environment).

- **`#bzHead`, slice 2b — `/api/buzzy/read` is real (done on this branch):** browse.js's
  reader half — a typed web address opened as text. `chat.nitro.ts` gains the session-gated
  route (`{ok, url, title, text, links}`, 40k cap, 422 with a named code when the page
  cannot be read) and `webpage.ts` gains `pageTitle`/`pageLinks` — absolute, de-duplicated,
  http(s)-only links, so a reader cannot be a text dump or carry a `mailto:`. The SSRF
  guard was already here and is now proven at the route: loopback and `169.254.169.254`
  are both refused with `code:"blocked"`. `scripts/test-buzzy-read.ts` covers the parser,
  the guard and the route; it reads a real public page when the machine has egress and
  SKIPs by name when it does not (16 PASS with a network). Privacy: the Lockdown check is
  present but cannot fire here until migration `0057` and the Privacy page are ported —
  stated in the route comment rather than pretending it guards.

- **`#bzHead`, slice 3 — the bar and the search are real (done on this branch):** web's
  Talk-to-BeeZilla bar and its search field now sit in `#bzHead` on this line. What was
  ported and what was cut, because "port browse.js" and "port the search" are not the same
  job:

  | Web piece | Here | Why |
  |---|---|---|
  | `.talk-card` / `.talk-bar` / `.talk-btn` / `.talk-field` / `.talk-send` / `.talk-extras` (talk.html CSS) | **ported**, same markup arrangement and rule values | The bar is what the owner described: one yellow Talk button, one box, attach. `#micBtn`, `#chatInput`, `#chatSend`, `#paperToggle` keep their ids, so the page's existing voice/chat/paper code binds unchanged. `paintVoice()` now swaps `.tb-glyph` instead of `textContent`, or the first paint would wipe the label and the SVG. |
  | `.bz-search`, results, chips, `.bz-icon-btn`, `.bz-share-btn` (browse.css) | **ported** | Search + copy-page-link. The QR button is not: no QR encoder is on this line, and a button that cannot draw a QR is the same theatre as a search box that cannot search. |
  | `.bz-reader*` (browse.css) + the reader half of browse.js | **ported** to `public/buzzy/head-search.js` | A typed address opens as text through `/api/buzzy/read` (slice 2b): title, paragraphs, links, breadcrumbs, Home/Back. |
  | Search across work | **ported, narrower** | `/api/buzzy/search` here returns three kinds — `jobs`, `sessions`, `documents` — so the chips are All plus those three kinds: the markup labels them Work / Chats / Documents, and `data-f` is `work` / `chats` / `documents`. Web's Pictures / Music / 3D / Skills / Recipes chips read `/api/buzzy/assets`, `/api/buzzy/recipes` and `window.BZ_EXPERTS`; those are Library's own surfaces on this line and the assets stay in the Library grid, so four empty chips would be worse than four honest ones. |
  | `browse.js` pane framework (`#bzTabs`, `#bzPane`, Inspiration/History panes) | **not ported** | This line serves Library, Memory, Experts and Recipes as their own pages; the panes would be a second navigation inside the first. The bar and search do not need them. |
  | `voice-stage.js`, `whiteboard.js`, `waveform.js`, the Idea Board, `/api/buzzy/board-recipes`, `/api/buzzy/whiteboards` | **ported** in CR-12 (see below) | Was "not ported — the next slice" at slice 3. The board store, the surface and the small server increment landed together, because a board without its store is a drawing that vanishes and a store without the surface is invisible. |

  `#bzPlaces` is no longer written in markup at all: `nav.js` builds its anchors from
  `LINKS` (`buildPlacesRow`, called by `paintPlacesRow`), in LINKS order, minus
  `DESKTOP_ABSENT`, and drops Talk because the bar is the way back. One list, so the row
  and the top nav cannot disagree. `desktop/smoke.mjs` now fails if `#bzPlaces` ships an
  anchor, if the bar/search markup is missing, or if `head-search.js` stops calling one of
  the three routes it depends on.

- **CR-12 — the Idea Board, its store, and the turn's live feed (done on this branch):**
  the piece slice 3 named as the next increment. What landed:

  | Piece | Where | What it does |
  |---|---|---|
  | The board's mount | `public/buzzy/talk.html` — `#obBoard` (folded, `hidden`), `#obParking`, `#boardToggle` under the Talk bar in `#bzHead` | A visit starts on a blank folded board; talking or sending opens it, Fold closes it (owner, 2026-11-20). The page owns four rules only — order, height, width, phone behaviour — because `whiteboard.css` is the board's own sheet. |
  | The board | `public/buzzy/whiteboard.js` (192,556 B), `public/buzzy/whiteboard.css` | Web's bytes: draws, saves, syncs, history. Publishes `window.BeeZillaWhiteboard`. |
  | The stage | `public/buzzy/voice-stage.js` (34,758 B), `public/buzzy/voice-stage.css` | Mounts the board, moves the Talk bar into its top edge while open, turns the page's voice state (`window.bzVoice`, `window.bzVoiceOut`) into the bar's words and face. Publishes `window.__bzFlow`, `__bzTurnStart`, `__bzTurnDone`, `bzBoardInstructions`. |
  | The player | `public/buzzy/waveform.js` | An audio card's player — `window.BeeZillaWave`. |
  | The store | `src/lib/buzzy/whiteboards.ts` + `main`'s `migrations/0061_buzzy_whiteboards.sql` | `GET/PUT /api/buzzy/whiteboards/:id`, `GET …/versions`, `POST …/versions/:vid/restore`. One board per person and conversation (or `talk`), revision-checked save, 30-version / 90-day history. |
  | Board recipes | `src/lib/buzzy/boardRecipes.ts` + `main`'s `migrations/0060_buzzy_one_board.sql` | `GET/POST /api/buzzy/board-recipes`, `DELETE …/:id` — a selection on the board becomes a recipe the person can run again. |
  | The turn's feed | `src/lib/buzzy/server.ts`, `chat.nitro.ts` | `FlowStep` events (`agent`, `memory`, `skill`, `output`) on the voice **and** typed lanes as SSE `flow`, sent before the model is called so the first card is agent.md and not a spinner. `boardInstructions` rides the message as instructions, appended to the persona — never substituted. |

  **Deliberate cuts (accepted, not drift):**

  - no `#talkWsThread` / `board.side` thread — the chat column stays the conversation,
    and the board is the work. Two scrollbacks on one page is two places to look for
    the same answer.
  - no `#aiKeyBtn`, no QR, no `browse.js` pane framework — this line holds no provider
    key to expose (`PARITY.md` "Managed inference"), has no QR encoder, and serves
    Library / Memory / Experts / Recipes as their own pages.
  - the "agent drawing" is the **real flow-step feed** (`FlowStep` → `window.__bzFlow`),
    not main's maker-carousel: the board draws what the turn actually read, ran and made.

  **Migrations: the board's tables are `main`'s, not this line's.** `buzzy_board_recipes`
  is created in `0060_buzzy_one_board.sql`, and `buzzy_whiteboards` /
  `buzzy_whiteboard_versions` in `0061_buzzy_whiteboards.sql` — both already on `main`,
  with the schema this line's `boardRecipes.ts` / `whiteboards.ts` reads. This branch
  carries no `0055`/`0056` and adds no migration of its own: the two files that briefly
  existed here were dropped in the rebase, because renumbering them would have created a
  second copy of tables `main` already owns.

  **What the smoke now proves** (`desktop/smoke.mjs`, 10/10 against `desktop/stage/app`):
  the mount, the folded state, `#boardToggle`, `#obParking`, both sheets and all three
  scripts are in the served `/buzzy/talk`, in dependency order (whiteboard.js before
  voice-stage.js); each asset answers 200 **and defines the global the next one reads**;
  `GET → PUT → GET /api/buzzy/whiteboards/talk` comes back at the saved revision with the
  card, through the runtime's own token path, and the same route without the token is 401.

  Found on the way: the smoke was setting `BZ_RUNTIME_TOKEN`, **a name no code reads**
  (`src/lib/local-owner.ts` gates on `BZ_LOCAL_TOKEN`, set by `scripts/beezilla-local.mjs`),
  so every smoke run had been an ungated runtime and "the request carried the token" was
  never tested. It now sets `BZ_LOCAL_TOKEN`, which is what makes the 401 assertion mean
  something.

## Verifying

```bash
npm run build && node desktop/smoke.mjs        # packaged runtime serves (10/10, incl. the board)
node desktop/dist.mjs all                       # installer + update manifest
# the board in a real browser, both widths (needs a built runtime + its token):
BZ_LOCAL_TOKEN=<token> node scripts/probe-idea-board.mjs http://127.0.0.1:7613
```

CI (`.github/workflows/desktop.yml`) runs the smoke test on every push that touches
`desktop/`, `src/lib/buzzy/`, `public/buzzy/` or `migrations/`.
