# The video lane — BeeZilla ⇄ the Breadcrumbs video-recipes kit

Status: **built, not deployed.** Writer/routing/executor/UX/safety are in code and
tested; the render server, the kit token and the kit itself are still with Shane.

## Shane's decisions (2026-11-17, 15:46 ET — room 6615)

| Decision | Where it lives now |
|---|---|
| Writer: Gemini Flash (`TEXT_MODEL=gemini-flash-latest`) | `BZ_VIDEO_TEXT_MODEL`, default `gemini-flash-latest` (`src/lib/buzzy/video.ts`) |
| End card: none — `--no-brand` on every public video, and QC must not fail a job for a missing card | `brand: false` on every job body (`BZ_VIDEO_BRAND` defaults off); kit-side `--no-brand` / QC change is still owed by whoever runs the kit |
| Thursday scope: all five recipes live | `VIDEO_RECIPES` — chalkboard, paper-cut tips, chart race, picture reel, narrated explainer; routing in `intent.ts` (`videoAsk`) |
| `DAILY_LIMIT_PER_USER=5` | `BZ_VIDEO_DAILY_LIMIT`, default 5; pre-checked in `server.ts` before the kit is called, and the kit's own 429 is surfaced |

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
BZ_VIDEO_DAILY_LIMIT=5                   # default matches Shane's decision
```

Kit-side checklist (not ours to set, but ours to verify before calling this done):

- `TEXT_MODEL=gemini-flash-latest` on the worker;
- `DAILY_LIMIT_PER_USER=5` on `serve.py`;
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
- Kit-side, still to do on the render server (not in this repo): `TEXT_MODEL=gemini-flash-latest`,
  `DAILY_LIMIT_PER_USER=5`, and `--no-brand` on all four kind commands in
  `worker.py` (all five scripts accept the flag; the QC window then stays at its
  base length instead of +10 s).
