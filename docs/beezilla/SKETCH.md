# BeeZilla Sketch — the art canvas

Status: implemented (phases 0–4), desktop parity pending.
Surface: `/buzzy/sketch?job=<project id>`
Route: `POST/GET /api/buzzy/art` → `src/lib/buzzy/art.nitro.ts`
Provider: `google/gemini-3-pro-image` via `BZ_CHAT_KEY` (override with `BZ_IMAGE_MODEL`)

## What it is

A canvas you compose on, then ask BeeZilla to render. You drop or paste real images,
then draw between them — a line from a car to a road, an arrow showing it driving, a
box around what must stay, a note that says "evening light". Press **Create** and the
model produces the finished image from that composition.

The board is the instruction. The prompt is a caption on top of it, not a substitute.

## Why it is built this way

- **The board is the conditioning.** `Create` flattens images + strokes + notes into a
  single PNG and sends it as an inline reference. A car connected to a road by a drawn
  arrow is a *spatial* instruction; text alone cannot carry it.
- **The drawing is data, not pixels.** Strokes are `{tool, color, width, points}` in
  board coordinates and live in `buzzy_jobs.data.board`. The PNG is an export. Editing
  never destroys what you drew, and a reload restores it from the server, not memory.
- **An image is a deliverable.** Rendered images land in `buzzy_assets` with `job_id`
  set, so the project page and the Library show the same file. Same rule as a track.
- **The harness performs the call.** No "the model may decide to draw": `Create`
  calls `/api/buzzy/art` directly, exactly as the music pre-pass does.
- **Quota is a plan rule, not a prompt rule.** `imagesPerDay`: free 0, starter 60,
  pro 400. A refusal is `402 plan_required` when the plan has no art and
  `429 quota_exhausted` when the day's allowance is gone — never a 5xx.

## Provider shape (measured)

The inference API has **no** `/images/generations` endpoint — it 404s. Image models
answer on `/chat/completions` with `modalities: ["image","text"]`, returning the picture
at `choices[0].message.images[0].image_url.url` as a `data:image/png;base64,…` URL.
One prompt with `google/gemini-3-pro-image` returned 5.2 MB of PNG.

## Board schema (v1)

```json
{
  "version": 1,
  "strokes": [
    {"tool":"pen","color":"#ffd40d","width":3,"points":[{"x":10,"y":10}]},
    {"tool":"arrow","color":"#ffd40d","x1":40,"y1":60,"x2":180,"y2":90},
    {"tool":"rect","color":"#ff6b6b","x1":0,"y1":0,"x2":120,"y2":80},
    {"tool":"text","color":"#ffffff","x1":20,"y1":30,"text":"evening light"}
  ],
  "images": [{"x":40,"y":40,"w":240,"h":160,"url":"/api/buzzy/assets/123"}]
}
```

## API

| Call | Purpose |
|---|---|
| `GET /api/buzzy/art?job=<id>` | board JSON + images already on this project |
| `POST {"action":"save","jobId","board"}` | persist the board |
| `POST {"action":"render","prompt","jobId","refs":[dataUrl]}` | render and store |

## Phases

| Phase | Scope | State |
|---|---|---|
| 0 | This document | done |
| 1 | `/api/buzzy/art` + `imagesPerDay` quota + `artConfigured()` | done |
| 2 | Deliverable linking (asset → job, status → `Deliverable ready`) | done |
| 3 | Canvas: drop/paste, brush, line, arrow, box, note, move/resize, save/load | done |
| 4 | Board-as-reference render + PNG export | done |
| 5 | Desktop parity in `agent-relay-local` | **open** — desktop routes through its own Nitro runtime and has no art surface yet; declared web-only in `docs/parity/functions.json` |

## Not built yet

- Chat-side `isImageRequest` pre-pass ("draw me a duck") — the canvas is the way in for
  now. The same guard lesson applies when it lands: the harness must perform the call.
- Undo history beyond the last stroke; layer ordering; per-stroke selection/delete.
- Iteration from a *previous render* as the reference (currently the board only).
- Vector export (SVG) of the drawn layer.
