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
- **Next slice — `#bzHead`:** the phone header still costs three rows on this line
  (brand, identity cluster, link row) because `public/buzzy/talk.html` predates the
  website's header (`#bzHead`: Talk to BeeZilla, the search, the row of places). nav.js
  collapses the header on web only where `#bzHead` exists; without it `bz-has-head` is
  never set and `#bzNav` cannot hide at ≤760px.

## Verifying

```bash
npm run build && node desktop/smoke.mjs        # packaged runtime serves
node desktop/dist.mjs all                       # installer + update manifest
```

CI (`.github/workflows/desktop.yml`) runs the smoke test on every push that touches
`desktop/`, `src/lib/buzzy/`, `public/buzzy/` or `migrations/`.
