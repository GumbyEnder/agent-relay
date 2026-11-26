---
status: active-handoff
date: 2026-11-03
owner: buzzy (Hermes profile)
tags: [beezilla, dev-boards, desktop, parity, release]
---

# STATE — 2026-11-03 — parity, desktop release, and what is open

Written so a fresh session can resume from here instead of from a transcript.

## Where the code is

| Line | Tree | Branch | HEAD | vs `github/main` |
|---|---|---|---|---|
| **web** | `~/agents/agent-relay-recipes` | `feat/buzzy-recipes` | `536b681` | 0 ahead / 0 behind |
| **desktop** | `~/agents/agent-relay-local` | `feat/local-runtime` | `04484b4` | 43 ahead / 1 behind |

Production `app.devboards.ai` is serving **`80c1f91`**. Everything since (`d1524f4`, `536b681`) is
docs + the parity script only — **no redeploy was needed and none was done**.

Desktop branch is pushed to `github` as `feat/local-runtime` (it existed only on this machine until today).

## What shipped today

1. **Parity register + gate** (`agent-relay-recipes`): `docs/parity/functions.json`,
   `docs/parity/PARITY.md`, `scripts/parity-check.mjs` (`npm run parity`). Fails when a page, API
   family or migration exists on one line and no register entry names it; when evidence paths die;
   when a declared state stops being true; when the installed app lags its branch.
   Post-merge: **26 `both` / 6 `desktop-only` / 0 `web-only`**, gate PASS.
2. **Desktop caught up**: `git merge github/main` into `feat/local-runtime` → 2 conflicts
   (`chat.nitro.ts`, `recipe-seal/recipes.nitro.ts`). Main's turn body won; `turn.ts` removed
   (it was a move of that body — recover from `9b287d3` if the refactor is wanted back).
   `settings` added to `PAGES`. 12 pages, 56 migrations, ASR/recorder/listen/nav/assets/graphs/
   frontier/pricing/music/3D all present on the local runtime.
3. **Release pipeline** (`agent-relay-local`): `desktop/release.mjs` → build, tag `desktop-v<version>`,
   GitHub release, verify size+sha256. Refuses dirty tree / no pins / dev pin without
   `--allow-dev-pin` (forces prerelease) / tag pointing at a commit other than the built one.
4. **Releases published** (both **Pre-release**: dev pin + unsigned):
   - `desktop-v0.2.0` — **BROKEN, do not install** (`ERR_MODULE_NOT_FOUND: resources\scripts\lib\inference.mjs`)
   - `desktop-v0.2.1` — current. 179,649,563 b, sha256 `42bda1bf…`. Fixes: `desktop/paths.mjs`
     (absolute file URLs for runtime imports), `desktop/logger.mjs` (`%APPDATA%\BeeZilla\logs\main.log`,
     2 MB rotation), PGLite staged at build time, `dist.mjs` import-resolution build gate.
5. **Distribution**: GitHub Releases are canonical (https://github.com/GumbyEnder/agent-relay/releases);
   LAN mirror at `K:\agents\Projects\Agent-Relay\releases\<version>\` (= `/mnt/nas/agents/Projects/Agent-Relay/releases/`)
   with a README per version carrying the exact digest and caveats.
6. **Installed copy**: Wine prefix `~/.wine-install` now runs **0.2.1** (asar `package.json` = 0.2.1).

## Open items — in priority order

### 1. Desktop "Connect BeeZilla account" opened an empty box — **FIXED in 0.2.2** ✅
Root cause: `desktop/connect.mjs` opened `${cloud}/connect`, and **`/connect` 404s on every
deployment** (demo 404, beezilla-production 404, app.devboards.ai 404 — all returning the ~1.9 kB
app shell, i.e. a blank window). `POST /api/inference-token` anonymously answers the correct
401 `unauthenticated`, so the flow behind it was sound; only the page was missing.

Fix: `CONNECT_PATH = "/login"` — same-origin, real sign-in UI everywhere. The e2e test missed it
because its fake cloud served `/connect`; added `scripts/test-connect-path-live.mjs`, which fetches
the real path and fails on 404/blank shell (`PASS … /login 200 2608b 271ms`).

Shipped as **0.2.2** (179,651,067 b, sha256 `5b4e74bf…`), mirrored to `K:\…\releases\0.2.2\`,
installed on this machine, `CONNECT_PATH = "/login"` verified inside the packaged asar.
**Needs one confirmation from the owner:** open Connect on Windows, sign in inside the window, and
check Settings shows a token with an expiry.

### 2. Code signing — release blocker
Every `signtool` step says "signing is skipped". SmartScreen warns on install. Needs a cert before
anything outside the lab. Everything else about the pipeline is ready.

### 3. Production recipe-publisher pins — release blocker
`publishers.json` in the repo is empty by design; builds use the dev pin `ed25519:devtest01`
("dev test only"), which is why both releases are prereleases. Real release needs
`BZ_RECIPE_PUBLISHER_FILE` pointed at the production key set.

### 4. Music — owner-blocked
ElevenLabs free plan → 402 `paid_plan_required` on both surfaces. Code is at parity.

### 5. App icon
Default Electron icon ("application icon is not set").

### 6. Turn refactor (cosmetic)
`turn.ts` was removed by the merge. Re-extracting the handler into a transport-free module is a
pure move; do it when there is test coverage to prove it.

### 7. Frontier ranking
Derived + refreshable by hand (`POST /api/buzzy/frontier/rebuild`, ops key). No Arena scraper.

## Commands a fresh session needs

```bash
# parity (web repo; compares both trees + the installed bundle)
cd ~/agents/agent-relay-recipes && npm run parity

# desktop runtime on a scratch data dir (no Electron needed)
cd ~/agents/agent-relay-local
BZ_DATA_DIR=/tmp/bz-rt node bin/beezilla.mjs serve --port 8791   # token in /tmp/bz-rt/runtime.json

# rebuild + publish the installer
BZ_RECIPE_PUBLISHER_FILE=<pins> node desktop/release.mjs [--allow-dev-pin] [--skip-build]
```

Traps that cost time today (also in the `buzzy-ops` skill): `pkill -f "beezilla.mjs serve"` kills
your own shell — use the pid in `runtime.json`; GitHub turns spaces in asset names into dots;
`BZ_SMOKE` cannot screenshot under Wine (prove the packaged runtime instead); a tag that points at
a commit other than the built one is worse than no tag.
