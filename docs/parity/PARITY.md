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

## Current state — 2026-11-03 (parity reached)

Web line `80c1f91`, desktop line `7b94027` — a merge of main into `feat/local-runtime`
(38 ahead, 0 behind). **26 functions `both`, 6 `desktop-only`, 0 `web-only`, 0 migrations
apart.** Every remaining difference is a capability that only makes sense on one surface.

### How the merge went

main had moved 156 commits while the desktop line built the local runtime. Two conflicts:

| File | Resolution |
|---|---|
| `src/lib/buzzy/chat.nitro.ts` | Took main's `/api/buzzy/chat` body — streaming, asset cards, cancellation, draft telemetry — over the Oct-27 turn. `turn.ts` was a *move* of that same body; keeping both would have left two implementations and one of them stale, so `turn.ts` and its two one-off extraction scripts were removed (recoverable from 9b287d3; re-extracting is a pure refactor). The inline `recordVoiceMetrics` stays out — it lives in `voiceMetrics.ts`, which now writes `lane` + `speech_ms`. |
| `src/lib/recipe-seal/recipes.nitro.ts` | Union of both import sets: local catalog (certs, cache) **and** cloud derive/ratings. |

Plus: `settings` joins `PAGES` on the desktop line so the Settings window resolves through
the router instead of a static `.html` fallback.

### Proof (fresh PGlite runtime, no data)

`node bin/beezilla.mjs serve` on an empty data dir:

- `/buzzy/talk` — **224,095 b**, `#bzNav` ×2, `startRecording` ×3, `bz_listen_mode` ×1 → nav, recorder and listen mode are the web's own files
- `/buzzy/graph` 200 (24,650 b), `/buzzy/library` 200, `/buzzy/settings` **200** (was 404)
- `/api/buzzy/pricing` 200 with per-MTok prices · `/api/buzzy/assets` 200 `{files:0}` · `/api/buzzy/graphs` 200 · `/api/buzzy/frontier` 200 · `/api/buzzy/voice-metrics` 200
- `/api/buzzy/transcribe` POST with an empty clip → **400 `audio_too_short`** with a sentence, not a crash
- migrations 0048/0049/0050 applied at boot; `tsc` clean; `vite build` "build complete"; inline `<script>` blocks parse in all 12 pages

### What is left

| Item | State |
|---|---|
| Installed app catching up | rebuilt with the merged tree; a **release** build still needs the production publisher key set (`BZ_RECIPE_PUBLISHER_FILE`) — the only pins on this host are dev-only |
| Music | code at parity on both surfaces; ElevenLabs free plan still answers 402 |
| `turn.ts` re-extraction | pure refactor, no behaviour change; do it when there is test coverage to prove the move |
| Arena scraper | ranking is derived and refreshable by hand; no scraper |

## Rebase discipline

`feat/local-runtime` is **37 ahead / 156 behind** `github/main` as of 2026-11-03. The two lines
have diverged for four days of web work (assets, graphs, frontier, pricing, music/3D, ASR).
Do **not** merge main into the desktop branch blindly: `chat.nitro.ts` and `server.ts` are both
touched on each side. Rebase, then re-run `npm run parity` — it will name exactly which
functions the rebase broke.
