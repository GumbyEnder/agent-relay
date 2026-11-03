# Parity — one product, two release lines

Dev Boards and BeeZilla ship from **one codebase on two clocks**:

| Line | Tree | Branch | Ships to | Cadence |
|---|---|---|---|---|
| **web** | `~/agents/agent-relay-recipes` | `feat/buzzy-recipes` → `github/main` | `app.devboards.ai` (Railway `agent-relay`) | continuous |
| **desktop** | `~/agents/agent-relay-local` | `feat/local-runtime` | BeeZilla installer (Electron shell + local runtime) | release-by-release |

That is not a mistake — the desktop must carry its own copy of the server to run offline
(Electron shell → `desktop/supervisor.mjs` → local Nitro runtime on PGlite, loopback bind,
per-launch bearer token). But two copies drift, and a desktop user cannot see the web's
changelog. So the rule is:

> **Divergence is allowed. Unrecorded divergence is not.**

## The register

`docs/parity/functions.json` — one entry per user-facing function, with:

- `state`: `both` · `web-only` · `desktop-only` · `drift`
- per-surface `evidence`: file paths, optionally with a marker (`public/buzzy/talk.html#bzNav`).
  The marker must be *present in the file*, so "we have this feature" cannot rot into
  "this file still exists".
- per-surface `pages`, `routes`, `migrations` — what the function is built from.
- `contract` — the cloud endpoints an **installed** desktop consumes. Changing one is a
  coordinated release, never a unilateral web deploy.

## The gate

```bash
node scripts/parity-check.mjs          # or: npm run parity
```

It fails (exit 1) when:

1. a page, an API family or a migration exists on one line and **no register entry names it**;
2. a register entry declares a page/route/evidence file that is no longer in the tree
   (register rot);
3. an entry's declared `state` disagrees with what the evidence proves.

It also prints behaviour markers side by side (canonical nav, listen mode, recorder/ASR,
asset shelf, local runtime) and, if a built app is present, whether that **install is behind
its own branch** — the failure a user actually feels.

Exit 2 means a tree could not be read (wrong path), never "something is wrong".

## Current state — 2026-11-03

Web line `80c1f91`, desktop line `27ee40d` (branch `feat/local-runtime`, which lives only on
one machine until now — it is pushed to GitHub as of this note so 37 commits can be rebased
instead of lost).

**Both lines (15 functions):** typed chat, model catalog + tool telemetry, voice out,
Library/documents/export, memory + company context, profile, experts/starters, recipes browse,
Honey Drops wallet, publish/upload, landing, outbound approval, inbox/digest/scheduled,
search inside a turn, Dev Boards board.

**Web-only (11):**

| Function | Why it matters |
|---|---|
| `voice.input` — recorder + `/api/buzzy/transcribe` | desktop voice input is the browser SpeechRecognition API only → **Chrome-only**; Firefox/Brave users cannot talk to the desktop app |
| `listen.mode` | listen intent not persisted on desktop |
| `nav.canonical` — `common.js` + `#bzNav` | desktop's 11 pages each carry their own nav; Talk/Library/Recipes can drift page by page |
| `assets.shelf` — `0048` | a dropped picture, song or `.glb` has nowhere to go on desktop |
| `cloud.token-minting` — `/api/inference-token` | the desktop **consumes** this; it must never host it |
| `search.cloud-gateway` — `/api/search` | our Brave key, token-gated |
| `graphs.whiteboard` — `0049` | whole orchestration programme absent on desktop |
| `frontier.ranking` — `0050` | model choice is a static list on desktop |
| `cost.pricing` | no real per-run cost without pricing.ts |
| `generation.music` · `generation.model3d` | depend on the asset shelf (and music on the ElevenLabs plan) |

**Desktop-only (6):** local runtime, `beezilla` CLI, Settings screen + BYOK key store,
connect-account (managed inference/search), local recipe fetch/verify/cache, installer.

## Port order (highest value first)

1. **`nav.canonical`** — copy `common.js` + the `#bzNav` block. Cheap, and it stops a whole
   class of page-by-page drift.
2. **`voice.input` + `listen.mode`** — one block of `talk.html` plus `asr.ts` and the
   `/api/buzzy/transcribe` route. This is the gap a user notices first.
3. **`assets.shelf`** — `0048` + two routes; the desktop runtime migrates at boot.
4. **`graphs` + `frontier` + `pricing`** — `0049`/`0050`, `runner.ts`, `graph.html`; the desktop
   can run the same resolver against local PGlite.
5. **`generation.*`** — last: they need the asset shelf and, for music, a paid ElevenLabs plan.

Porting means: land the change on `feat/local-runtime`, flip the entry to `both` in the same
commit, run `npm run parity`, and prove it in the packaged app.

## Rebase discipline

`feat/local-runtime` is **37 ahead / 156 behind** `github/main` as of 2026-11-03. The two lines
have diverged for four days of web work (assets, graphs, frontier, pricing, music/3D, ASR).
Do **not** merge main into the desktop branch blindly: `chat.nitro.ts` and `server.ts` are both
touched on each side. Rebase, then re-run `npm run parity` — it will name exactly which
functions the rebase broke.
