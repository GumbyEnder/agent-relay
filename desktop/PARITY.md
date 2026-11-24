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
- `migrations/*` up to the highest applied number; the desktop must never invent a
  number `main` has not used.

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
  bar is 76px (web 77) and the row is one line. The row names Talk itself because web gets
  Talk from the Talk-to-BeeZilla bar, which this line has not ported — drop that anchor the
  day the bar lands.
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

- **Next slice — the head's bar and search, measured so it can be cut:** the dependencies
  are not one route. Counting the tree as it stands:

  | Dependency | Size | Needs | State here |
  |---|---|---|---|
  | `/api/buzzy/search-status` | 24 lines | `search.ts` | **done (2a)** |
  | `/api/buzzy/read` | 43 lines + `pageTitle`/`pageLinks` in `webpage.ts` | SSRF-guarded reader (already here) | **done (2b)** — honours Lockdown only once 0057/Privacy land on this line |
  | `/api/buzzy/board-recipes` | — | board store | absent |
  | `browse.js` | 835 lines | `#bzSearch`, `#bzResults`, `#bzResultsGrid`, `#bzSearchNote`, `#bzTabs`, `#bzPane`, `.bz-search`; `window.BZ_EXPERTS`, `BeeZillaInspiration`, `BeeZillaWave`; `browse.css` (365 lines) | 0 of 7 DOM hooks, 0 of 3 globals (`#bzBrowse` root and `#recentBelow` exist) |
  | `voice-stage.js` | 692 lines | `#obStart`, `#obBoard`, `#obParking`, `#boardToggle`, `#talkWsThread`, `#micBtn .tb-level`, `window.bzVoice`, `bzVoiceOut`, `__bzFlow` | 0 of 9 (the page has `#micBtn`, `#composerCard`, `#chatInput`, `#chatMessages` but no `.tb-level` and no voice-state object) |

  So the bar is not a nav increment: on web the composer *lives inside* `#bzHead` (with
  the Idea Board and the parking area), whereas this line's composer sits below the head
  and its voice engine is inline in `talk.html`. Porting `voice-stage.js` means moving
  the composer into the head and handing dictation/level state to a script that currently
  only reads `window.bzVoice` — a Talk-page change, not a header change. `browse.js` drags
  the pane framework (Inspiration/History/Library/Memory/Experts/Recipes as inline tabs)
  that this line deliberately serves as separate pages, plus two routes that do not exist
  here. Landing the markup first would be the search box that cannot search.

## Verifying

```bash
npm run build && node desktop/smoke.mjs        # packaged runtime serves
node desktop/dist.mjs all                       # installer + update manifest
```

CI (`.github/workflows/desktop.yml`) runs the smoke test on every push that touches
`desktop/`, `src/lib/buzzy/`, `public/buzzy/` or `migrations/`.
