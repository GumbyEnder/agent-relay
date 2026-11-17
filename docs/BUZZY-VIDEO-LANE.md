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
- the five recipe ids on disk match `VIDEO_RECIPES` in `video.ts`;
- `POST /jobs` request field names confirmed against `JOB-CONTRACT.md`
  (`jobBody()` in `video.ts` is the single place to correct them).

## Honest gaps

- The kit is password-protected and not on disk: recipe ids other than
  `explain-on-a-chalkboard` are the kebab-case convention, pending one read of
  `recipes/`.
- `POST /jobs` body field names are provisional; the response shape and the
  failure codes come straight from the brief.
- The write path (ownership row, daily count, asset storage) needs Postgres, so it
  is exercised by the live E2E, not by the unit tests.
- The Recipes-page card (one input box, queued → making → done with ETA) is not
  built yet; the chat path is.
