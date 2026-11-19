# The video lane — BeeZilla ⇄ the Breadcrumbs video-recipes kit

Status: **built, rebased on the live main, and proven end-to-end against the real
kit on BeeServer.** Not deployed: production needs `BZ_VIDEO_BASE`,
`BZ_VIDEO_KIT_TOKEN` and a Google TTS key from Shane (6615), and the render box
needs the three kit patches below applied by `beezilla-kit-patches.py`.

## Shane's decisions (2026-11-17, 15:46 ET — room 6615)

| Decision | Where it lives now |
|---|---|
| Writer: Gemini Flash (`TEXT_MODEL=gemini-flash-latest`) | `BZ_VIDEO_TEXT_MODEL`, default `gemini-flash-latest` (`src/lib/buzzy/video.ts`) |
| End card: none — `--no-brand` on every public video, and QC must not fail a job for a missing card | `brand: false` on every job body (`BZ_VIDEO_BRAND` defaults off); kit-side `--no-brand` / QC change is still owed by whoever runs the kit |
| Thursday scope: all five recipes in the kit; **CR-1 ships four** (picture reel later) | `ALL_VIDEO_RECIPES` is the kit's five (chalkboard, paper-cut tips, chart race, picture reel, narrated explainer). `VIDEO_RECIPES` is what BeeZilla offers = the catalogue minus `HELD_BACK_RECIPES` (`picture-reel`, Shane 2026-11-19: "4 of 5 recipes, picture-reel later"). The Recipes page, the `generate_video` enum and the chat pre-pass all read `VIDEO_RECIPES`; `createVideoJob` refuses a held-back id with one sentence before any HTTP call. Routing in `intent.ts` (`videoAsk`) still recognises all five so the refusal can name the recipe. |
| Quota: `DAILY_LIMIT_PER_USER=5` | ONE flat cap, every plan: `DAILY_LIMIT_PER_USER` in `src/lib/buzzy/video.ts`, returned by `videoDailyLimit()` — it gates the chat pre-pass, the tool and `GET /api/buzzy/video`; the kit's own 429 is the backstop. There is no plan split and no `videosPerDay` field: a per-plan table (10 Pro / 1 Free) was a product change with an invented citation and was corrected back to 6615. |

## CR-1: four of five, picture reel held back (2026-11-19)

Shane, 2026-11-19: "CR-1 ships today with 4 of 5 recipes, picture-reel later."
The reason is the kit's own behaviour: with no seeded picture library it refuses
with `pictures_unavailable` instead of half-rendering (reproduced 2026-11-19 on a
13 MB JPEG-only library), so offering it would turn a person's request into a
failure minutes later. To switch it on, remove `"picture-reel"` from
`HELD_BACK_RECIPES` in `src/lib/buzzy/video.ts`; nothing else changes.
`DAILY_LIMIT_PER_USER` stays 5, one flat cap for every plan. The deployment stays
unconfigured (`BZ_VIDEO_BASE` / `BZ_VIDEO_KIT_TOKEN` unset) until Shane stamps
the sha.

## What the code does

1. **Always starts the job.** `videoAsk()` in `src/lib/buzzy/intent.ts` recognises
   the five recipes (and "infographic" as the chalkboard), returns recipe + topic,
   and the pre-pass in `src/lib/buzzy/server.ts` starts the render before the model
   is asked anything. The model never decides whether a video happens; it narrates.
2. **Tool surface.** `generate_video` is in `toolRegistry.ts` (draft-gated,
   40s budget, metered, egress) for the case where the model is the one deciding
   (a follow-up inside an open brief). Its executor starts the same job.
3. **Server-side executor.** `POST /jobs` with `X-Kit-Token` (never in the browser),
   `GET /jobs/<id>` poll, `GET /jobs/<id>/files/<name>` download. The mp4, the
   thumbnail and the post text are stored in `buzzy_assets` — one shelf, one
   download route — and the page polls `GET /api/buzzy/video/<id>` until they land.
4. **Ownership.** The kit token can read any job, so a kit job id proves nothing.
   `buzzy_video_jobs` (migration 0058) records `job_id → user_id` before the id is
   handed to the page; a poll for someone else's job is a 404.
5. **Topics stay out of the DB and out of logs.** The row keeps `sha256(topic)`.
6. **UX (Shane's rule for every generated asset).** A stage line in Chat the moment
   the job starts (`phase: "video"`), the finished video inline under the prompt
   that asked for it (player + thumbnail poster + post text), and a copy in the
   Library. The card carries "Review before posting — this video was made with AI".
7. **Refusals are honest.** Lockdown, not-configured, daily limit, queue full and
   a refused topic each become one sentence, and nothing is claimed as made.

## Environment, when the render server exists

```
BZ_VIDEO_BASE=https://<render-host>      # no trailing slash
BZ_VIDEO_KIT_TOKEN=<from Shane>          # server-side only
BZ_VIDEO_TEXT_MODEL=gemini-flash-latest  # default matches Shane's decision
BZ_VIDEO_BRAND=0                         # default: no Breadcrumbs end card
BZ_VIDEO_DAILY_LIMIT=5                   # optional flat override; default 5
```

Kit-side checklist (not ours to set, but ours to verify before calling this done):

- `TEXT_MODEL=gemini-flash-latest` on the worker;
- `DAILY_LIMIT_PER_USER=5` on `serve.py` — the same flat number BeeZilla enforces
  (6615). The kit cannot see plans and needs to: there are none to see.
- the end card disabled (`--no-brand`) for **all five** recipes, not just the
  chalkboard, and the QC gate no longer failing a job when the card is absent;
- the five recipe ids on disk match `VIDEO_RECIPES` in `video.ts`;  ✓ confirmed 2026-11-17
- `POST /jobs` request field names confirmed against `JOB-CONTRACT.md`.  ✓ confirmed 2026-11-17

## The contract, as read from the kit (2026-11-17)

Zip sha256 `9793bbbc619d03d9463ae49c9a6a4cc7e7a62d6b22d0ce9cbffa09bab1c78364`
(the zip and the kit password are NOT in this repo and must never be committed).

`POST /jobs` takes `kind`, never a recipe id. The five recipe ids are the kit's
own — the `recipe` field of each `recipes/<id>.recipe.json`:

| Recipe id | kind | other fields |
|---|---|---|
| `explain-on-a-chalkboard` | `tips` | `look: "chalk"`, `board` (7 colours, default `forest`) |
| `ai-creator-tips-paper-cut` | `tips` | `look: "paper"` (ignores `board`) |
| `chart-race-from-your-numbers` | `chart` | `question`, `data_csv`, `source`, `chart`, `unit`, `format`, `ai_text` |
| `picture-reel` | `reel` | `pictures: "library" \| "ai"` |
| `narrated-explainer` | `explainer` | — |

All kinds: `user` (app user id, cut to 80). `kitJobBody()` in `video.ts` is the
single place that builds and validates this, and the limits there are serve.py's
own (topic 8–200, question 8–80, source 3–120, CSV non-empty < 200 KB).

Three keys the old body sent that the kit ignores silently — removed:
`recipe`, `brand`, `text_model` (and `user_id`, which serve.py never read).
The end card is a per-script `--no-brand` flag on the render side; the writing
model is `TEXT_MODEL` in the worker's environment. Neither is a job field.

`GET /jobs/<id>`: `files` is an OBJECT keyed by role
(`{video, thumbnail, post}`) — reading it as an array was the bug that made a
finished render look empty. Also surfaced: `cause`, `charge`, `attempt`,
`seconds`, `rounds`. The status call carries NO `eta_minutes`; only the 202 does.

## Honest gaps

- The chart race cannot be started from a sentence: the job body needs the
  table and the source. Chat asks for them (`needsTable` on `videoAsk`); the
  Recipes card is where the table is collected.
- The write path (ownership row, daily count, asset storage) needs Postgres, so it
  is exercised by the live E2E, not by the unit tests.
- The Recipes-page card (questions from `recipe.asks`, queued → making → done
  with ETA) is not built yet; the chat path is.
- Kit-side, still to do on the production render server (not in this repo):
  `TEXT_MODEL=gemini-flash-latest`, `DAILY_LIMIT_PER_USER=5`, and the three
  patches below applied by `beezilla-kit-patches.py`.

## Proven against the real kit (2026-11-17, BeeServer, dev run)

The kit was already unpacked on BeeServer (`~/video-kit`, bootstrap proof MP4
30.0 s) — no password needed to test against it. Ran `serve.py` + `worker.py`
from `beezilla-video-dev.sh` and drove them through **this repo's client**
(`startKitJob` → `readVideoJob` → `fetchVideoFile`), not curl:

| Run | Job | Wall | Result |
|---|---|---|---|
| chalkboard, "three months of cash" | `20261117-231007-7574c4` | 165 s | done, 3.24 MB MP4, 56.1 s, 1080x1350, audio, QC PASS, −16.0 LUFS, 0 blank frames, thumbnail 172 KB, post text 274 B, `branded: false` |
| chart race, invented table | `20261117-231622-2b1409` | 24 s | done, 3.72 MB MP4, 30.0 s, 1080x1350, QC pass, `branded: false`, files `video.mp4/thumbnail.jpg/post.txt` — the role-keyed mapping that differs per kind |
| chart race, 5-row table | `20261117-231553-e8b2d0` | 4 s | failed, `charge: false`, kit sentence "A race needs at least 6 dated rows; this file has 5." — the sentence now reaches the person (patch 3) |
| chalkboard, dead writer key | `20261117-230925-c85aed` | 5 s | failed, `render_failed`, `attempt: 2`, `charge: false` — failures are never charged, client surfaced the kit's own sentence |

Dev-run substitutions, both deliberate and both forbidden in production:
`VOICE_PROVIDER=edge` (no Google TTS key yet — production is `google`, one
voice rule) and the writer on an OpenAI-compatible endpoint
(`google/gemini-3.8-flash`, the same family as Shane's `gemini-flash-latest`,
until his Google key lands).

## The three kit patches (`beezilla-kit-patches.py`, NAS `host-ops`)

The kit is proprietary and outside git, so these live as a tracked, idempotent
patch script (`.orig` kept beside each file, `--check` / `--revert`):

1. **`worker.py` never passed `--no-brand`** — every per-recipe CLI accepts it,
   but the only caller that launches a render did not, so every job carried the
   10 s Breadcrumbs card. Now `--no-brand` on all four commands unless
   `NO_END_CARD=0`. Verified: `branded: false` on both successful renders.
2. **`make_chart.py` cannot start on Python 3.14** — `--unit` had
   `help="... e.g. GW or %"` and argparse runs `help % params`, so every chart
   job died in 0.2 s with `ValueError: badly formed help string`. Fixed the help
   string; the recipe now renders in 24 s.
3. **`worker.py` discarded the actionable failure sentence** — it replaced every
   cause except `topic_refused` with a curated line, so "A race needs at least 6
   dated rows" became "Making the video failed on our side." The recipe's own
   sentence now wins whenever the worker has no curated one.

QC needed no change for a missing card: `check_video.py` never looked for one —
the max length simply stays 65 s instead of 75 s.
