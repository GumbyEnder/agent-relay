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
  lookalike — `public/buzzy/nav.js` is byte-identical to what beezilla.net serves
  (135,298 B, md5 35613e333dc6b6db1ebf3cccab063f5e), `nav.css` is web's, and
  `src/lib/buzzy/pages.nitro.ts` writes NAV_ROW once and substitutes it into every page
  (plus the nav.js/nav.css links). `desktop/smoke.mjs` now fails if the served row is
  not the eleven links in web order. Before: eight or ten hand-written anchors, order
  Talk / Capabilities / Sketch / Memory / Experts / Recipes / Honey Drops / Publish,
  `target="_blank"` on Library, literal "Sign in".
- **CR-8, the two pages the row names (done on this branch):** `public/buzzy/studio.html`
  and `public/buzzy/download.html` are web main's bytes, `chat.js` is web main's, and
  `src/lib/buzzy/studio.ts` + `studio.nitro.ts` are ported with the `/api/buzzy/studio`
  route listed before the `/api/buzzy/**` catch-all in `vite.config.ts`. Migration
  `0054_buzzy_music_edits.sql` keeps web's number (the desktop must never invent one).
  `desktop/smoke.mjs` now follows every `#bzNav` href and fails if any answers
  non-200 or renders without the nav, so a link the row inherits from the website
  cannot 404 here unnoticed.

## Verifying

```bash
npm run build && node desktop/smoke.mjs        # packaged runtime serves
node desktop/dist.mjs all                       # installer + update manifest
```

CI (`.github/workflows/desktop.yml`) runs the smoke test on every push that touches
`desktop/`, `src/lib/buzzy/`, `public/buzzy/` or `migrations/`.
