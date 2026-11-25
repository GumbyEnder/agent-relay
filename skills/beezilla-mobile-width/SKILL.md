---
name: beezilla-mobile-width
description: CR-12 gate — prove no /buzzy page hangs chrome past 390px.
version: 1.0.0
author: GumbyEnder
license: MIT
metadata:
  hermes:
    tags: [beezilla, chrome, mobile, regression, cr-12]
    category: project-specific
---

# CR-12 — beezilla-mobile-width

**Trigger:** any change to a `/buzzy` page, or to the shared chrome (`nav.js`,
`pages.nitro.ts`, `talk.html`'s own header), before it is called done. Answer one
question with one command: does anything hang past the right edge at 390px?

## Why this exists

The 390px class of bug has now cost two rounds: the 179-vs-172 header bar, then the
sessions drawer parked at `translateX(100%)`. Both times the naive check —
`document.scrollWidth` — said the page was clean while real boxes sat outside the
viewport. Chromium does not raise a scrollbar for an off-canvas element, so
`scrollWidth` equals the viewport and every screenshot looks fine. The page still
renders a 359px box at left 390 on a 390px phone, the desktop shell's width probe
reads it as overflow, and a drawer's buttons stay focusable while it is "closed".

**The pass condition is not "no scrollbar". It is zero elements whose right edge is
past the layout viewport.** A transform is not a fix; leaving layout is.

## The probe

```bash
node scripts/probe-mobile-width.mjs [origin] [storageState.json]
```

- `origin` — default `http://127.0.0.1:3000` (`npm run build && node .output/server/index.mjs`).
  `https://beezilla.net` works too, but signed out the app pages redirect to `/buzzy/landing`.
- `storageState.json` — a Playwright storageState for a signed-in session. Signed out,
  Talk redirects to Landing, so the drawer is never exercised.

It visits talk, library, download, sketch and studio (`orchestrate` was in the original
brief and 404s — studio is the page that took its place), at 390 and 1280, and on Talk
drives the drawer **closed → open → minimised (pill) → reopened from the pill → closed**.
Per state it prints: `over` (offending elements), `scroll` vs `client` (the old lying
check), `brand` (`.bz-brandrow` height), `head` (`#bzHead` height) and the worst selector.

Exit 0 = every state clean. Exit 1 = at least one element past the right edge (or a
closed drawer that is still `display:flex`, or a reopened drawer that stayed unmounted).
Exit 2 = the probe could not run.

Two rules the probe encodes, both learned the hard way:

- **Clipping counts.** An element inside an ancestor whose `overflow-x` is not `visible`
  cannot widen the document, so it is not counted. Without that rule every horizontal
  scroll strip is a false alarm and the probe gets ignored.
- **`clientWidth`, not `innerWidth`.** With a vertical scrollbar the layout viewport is
  ~15px narrower than `innerWidth`; a box in that band is genuinely cut off, and
  `innerWidth` hides it.

## The invariant (what a page must look like)

1. Off-canvas chrome is **`display:none` when closed**, gets `mounted` on open (with a
   forced reflow before the `open` transition so it slides rather than jumps), and drops
   `mounted` only after the close transition (~180ms).
2. The close timer's handle is kept and **cleared by every open**. A close followed by an
   open inside the transition window otherwise fires after the new open and unmounts the
   drawer that was just opened.
3. Anything that stays in layout while closed — a translated panel, an absolutely
   positioned overlay, a `visibility:hidden` box with size — is a CR-12 failure even if
   it is invisible.
4. Focus: a closed drawer's buttons must not be in the tab order. `display:none` gives
   that for free; `transform`/`opacity`/`visibility` do not.

## Where chrome may be changed

- The nav row lives in **two places that must agree**: `public/buzzy/nav.js` (`LINKS`) and
  `src/lib/buzzy/pages.nitro.ts` (`NAV_ROW` + the `PAGES` set). A new page needs both.
- **No page-local nav.** Pages get the shared row from the shell; a page that paints its
  own copy will drift (the raw `talk.html` header keeps its own exemptions only until
  `#bzHead` lands everywhere).
- Scripts must not mutate the nav by index. Two did: `common.js` relabelled Talk as
  "Jobs", `wallet-chip.js` inserted the Drops chip as the first child. Address nodes by
  id or `data-*`, never `children[0]`.

## Baselines (measured 2026-11-23, signed in, built server — with the #367 drawer fix in)

These rows are the **clean** tree: main after `d457c42` (#367), the commit that takes the
closed conversations drawer out of layout. They are not a 75609cc measurement; the
pre-fix numbers are in the paragraph under the table.

| measurement | 390 | 1280 |
|---|---|---|
| overhang, every page, every drawer state | 0 | 0 |
| `docScrollWidth` | 390 | 1280 (client 1280) |
| `.bz-brandrow` height | 172 (wraps, intended; 146 at 414, 56 from 768 up) | 56 (fixed in `nav.js`) |
| `#bzHead` height | 549 on app pages (597 at 360) | 357 |

`#bzHead` height is content-dependent (it contains the search block) — it is printed for
comparison, never asserted. The brand row is asserted at ≥1000px only, because below that
it is allowed to wrap; the phone band is 172 at 360–390, 146 at 414, so read the value,
never pin it. On 75609cc the same probe reports **10 elements past the right edge
on Talk, worst `#sessionsDrawer` at +359px (390) / +380px (1280)**; with the drawer fix it
reports 0 across 18 measurements. Use that pair as the regression's living proof.

## Evidence the probe must produce

One command, signed in, against a built server:

```bash
npm run build
node scripts/probe-mobile-width.mjs http://127.0.0.1:PORT state.json   # PASS — 0 elements past the right edge
```

Paste the table, not a description of it. `PASS — 0 elements past the right edge across N
measurements` is the line that closes a CR-12 review; "the page looks fine at 390" does not.

## The pointer-exit arm — `scripts/probe-no-outside-close.mjs`

Width alone does not cover the other half of the same rule: **anything that opens must
close on a pointer press, and must not close on a stray one.** That is #361, and this
tracked probe is its gate. It is the same file the screen rules cite, extended rather
than duplicated — a second probe doing 60% of this would drift.

```bash
node scripts/probe-no-outside-close.mjs [origin] [session] [widths]
#   origin   default http://127.0.0.1:8080
#   session  Playwright storageState .json, or a one-line `session_token=...` file;
#            omitted, it signs a throwaway account in through the dev magic-link inbox
#   widths   default 360,390,430,1366
```

Per panel it asserts three things, then the negative:

- **inside** — the exit control's box is wholly inside the layout viewport;
- **hittable** — `document.elementFromPoint(centre)` is the control (or inside it). An
  element under an overlay screenshots fine and eats taps;
- **closes** — a real Playwright click takes the panel out of view;
- **stray press** — a click at the viewport corner leaves the panel open *with typed
  text intact* (the key dialog's API key, the recipe dialog's brief).

Covered panels and their exits, at `63a0278`:

| page | panel | exit | mechanism |
|---|---|---|---|
| talk | settings `#bzSettings` | `.bzs-close` | stays in DOM, toggled `[hidden]` |
| talk | privacy `#privacyPop` | `#privacyClose` | stays in DOM, toggled `.hidden` class |
| talk | AI key dialog `.ob-dialog` | `.ob-x` | removed from DOM |
| recipes | purchase dialog `.bz-modal` | `.cancel` ("Cancel") | removed from DOM |
| recipes | "Use this recipe" `.bz-modal` | `.cancel` ("Close") | removed from DOM |

**Presence is not open/closed — three mechanisms, so one test cannot cover all five.** Asking
"is the node present" reports a false failure against the settings panel and the privacy
pop-up, which never leave the DOM; asking "is it visible" reports a false pass against the
two dialogs mid-close. Each check uses the mechanism that panel actually has, and the
reason sits in the file header.

**Neither recipe dialog has an X, and that is correct.** `docs/BEEZILLA-SCREEN-RULES.md`
§Critical asks for "its own X (or a button that says Close or Cancel)". A verification that
counts controls instead of reading the rule reports a defect in working code — that misread
has already happened once. `.ob-x` exists only in `voice-stage.js`.

Measured 2026-11-25 on `63a0278`, signed in, production build, 360 / 390 / 430 / 1366:
**100 checks, 0 failures** (25 per width; the per-check lines are the receipt, not this
sentence). Screenshots of the two button-only panels at 360 are in
`docs/evidence/dialog-exits/`.

The recipes half needs seeded demo data (`SEAL_SEED_BASE` + `SEAL_SEED_COOKIE` →
`scripts/seed-demo-recipes.ts`) and a build carrying the private marketplace modules; an
open build answers `marketplace_disabled` and those cases report FAIL instead of skipping.
Do not "fix" that by skipping them.

## Traps

- **A built checkout 500s with ENOENT on `pglite.data`** if `.output/server/_libs` was
  wiped by `npm run build`. Copy `pglite.data`, `pglite.wasm` and `initdb.wasm` from
  `node_modules/@electric-sql/pglite/dist` (what `scripts/test-*.mjs` do).
- **Magic-link sign-in needs the dev mail inbox**: boot with `AGENT_RELAY_DEV_MAIL=1`,
  `AGENT_RELAY_MAIL_LOG_DIR=<dir>`, `BETTER_AUTH_URL`/`BETTER_AUTH_TRUSTED_ORIGINS` set to
  the ephemeral origin, and no `RESEND_API_KEY`/`SMTP_*` in the env.
- **The drawer's own toggle is inside the folded `#obParking`**, so it is not clickable on
  today's Talk page; the probe drives the same handlers with `element.click()` and says so
  in a note. When a real affordance appears, the probe uses it automatically.
- Known pre-existing errors on `sketch`/`studio` (main, signed in, fresh account):
  `window.op is not a function` and `Cannot read properties of undefined (reading '1')`.
  They are printed by the probe and are **not** CR-12 failures — do not let them hide a
  real overhang, and do not "fix" them in a width PR.
