# Testing BeeZilla locally, signed in

The manual every agent needs before touching a `/buzzy` page. Everything here was learned the
hard way between 2026-11-13 and 2026-11-23; each trap is listed where it bites.

## 1. Why `npm run dev` is not enough

`npm run dev` (vite) does **not** serve the `/buzzy/*` pages — they 404. Only a production
build does. HTML pages are read from `public/buzzy` at request time, but `nav.js` and every
other static file come from `.output/public`, so **rebuild after changing any static file**.
Never copy an edited file into `.output/public`: Nitro bakes each file's size into the build,
the browser gets it cut off, and the script fails silently ("Unexpected end of input").

## 2. Build in your own worktree

```bash
git worktree add -b <branch> <folder> upstream/main   # never work in the shared main checkout
cd <folder>
npm ci                                                 # ~5-10 s; main's lockfile moves ahead of shared node_modules
node scripts/sync-private.mjs                          # stubs are fine
NODE_ENV=production npm run build                      # ~1-3 min
cp node_modules/@electric-sql/pglite/dist/{pglite.data,pglite.wasm,initdb.wasm} .output/server/_libs/
```

Without the three PGlite files, PGlite fails and sign-in breaks. PGlite is in memory: a
rebuild or restart starts empty, so sign in again (an old cookie lands on the sign-in page and
`#chatInput` never appears).

## 3. Run it

```bash
PORT=3141 NITRO_PORT=3141 HOST=127.0.0.1 \
BETTER_AUTH_TRUSTED_ORIGINS=http://127.0.0.1:3141 \
BZ_CONSUMER_HOSTS=127.0.0.1 BZ_DEFAULT_PLAN=pro \
node .output/server/index.mjs
```

- Only ports 8080/8090 are trusted by default; set `BETTER_AUTH_TRUSTED_ORIGINS` for yours.
  Other sessions hold ports; pick a spare one.
- `BZ_CONSUMER_HOSTS=127.0.0.1` makes 127.0.0.1 answer like beezilla.net (`/` → `/buzzy/talk`).
  The console (and the agent API, `/api/agent/*`) is then on `localhost:<port>`.
- `BZ_DEFAULT_PLAN=pro` shows a paid plan.
- **A Bash call that ends kills the servers it started** (even with `nohup … &`), and a
  background server may be stopped after a while. What works every time: one script that
  starts the server, waits for `curl` to answer, runs the probe, and stops the server.
- Stop a server **by port**, not by name: `lsof -iTCP:<port> -sTCP:LISTEN -t | xargs kill`.
  `pkill -f` on the relative command line matches nothing, and an old server keeps serving
  old static files while the new one silently fails to bind. After every rebuild, compare
  `curl -s <origin>/buzzy/<file> | wc -c` with the source.

## 4. Sign in

Fastest: `POST /api/auth/sign-in/magic-link` with an `origin` header; the dev mailer writes the
link to `.data/outbound-mail.jsonl` in the server's folder. **That file is written only while the
dev inbox is on** — with SMTP configured it is skipped entirely, so a production sign-in link never
lands on disk. Boot locally with `AGENT_RELAY_DEV_MAIL=1` (and no `SMTP_*`) to get it. Open it with
the host swapped for
yours and keep the `session_token` cookie. (Email sign-up also works: the verification link is
printed in the server log as `[mail:dev] … Link: …`.) `scripts/probe-*.mjs` do this already
(`BZ_MAIL_LOG=<server folder>/.data/outbound-mail.jsonl`).

## 5. A model without any key

- **Stand-in model** (fast, deterministic): a tiny OpenAI-compatible server on a spare port that
  answers `/v1/chat/completions` — stream and non-stream — and returns the tool call your test
  needs. Start BeeZilla with `BZ_CHAT_BASE_URL=http://127.0.0.1:<port>/v1 BZ_CHAT_KEY=local-test
  BZ_CHAT_MODEL=stand-in BZ_EXTRACT_MODEL=stand-in`. Pointing the base URL at localhost makes
  the model catalog local.
- **A real local model**: this Mac runs Ollama at 127.0.0.1:11434 with
  `browser-use:qwen3.8-27b-q8-64k`. It is a thinking model: through the OpenAI-style API it
  returns only `reasoning` unless the request has `"reasoning_effort": "none"`, so put a small
  proxy in front that adds that field (and `max_tokens` ≥ 600). A turn takes 20–60 s. Local Qwen
  rejects a trailing system message ("system message must be at the beginning").

## 6. Drive a real browser

- Use the windowless test browser (`~/.claude/skills/use-ai-screen/scripts/ai-screen.sh browser`
  prints a DevTools address) and Playwright `chromium.connectOverCDP(address)`; the repo's own
  Playwright browser isn't installed on this Mac. Never put a window on the owner's screen.
- A script that connects over CDP must end with `process.exit(…)` or Node hangs.
- Block `https://openpanel.dev` in probes: its script throws on 127.0.0.1 and a probe is not a visit.
- The site lifts every `title` into its own tooltip and removes the attribute while hovering:
  assert `aria-label`, not `title`.
- Playwright's `click()` scrolls `overflow:hidden` ancestors into view; a toolbar that overflows
  at 390 px looks "offset" in screenshots after a click.
- "Broken on Brave" reports were page-switching bugs a reload hid. Before blaming a browser,
  replay page switches: open a page, open a second, go back to the first. For a real Brave:
  `~/Applications/Brave Browser.app/Contents/MacOS/Brave Browser --headless=new
  --user-data-dir=<scratch dir> --remote-debugging-port=<port> --use-mock-keychain
  --password-store=basic --no-first-run` — never the owner's own profile.
- A test that "refuses private addresses" must never be able to connect: check address forms
  with the pure function first, connect-style tests after.

## 7. Checking several branches together

Merge the branches into a throwaway branch off `upstream/main`, `npm ci`, build once, run on a
spare port. Each branch still runs its own typecheck and tests. `NODE_ENV=development CI=true
npm run test:ci` takes about 15 minutes after a build; zsh doesn't word-split `$t` in
`for t in "cmd args"` loops — use `bash -c "$t"`.

## 8. Wiring a new test into CI

`test:ci` is one long line that almost every open PR edits, so add tests through an npm
lifecycle hook on a script already in the chain (`"posttest:<script>": "…"`). Never reuse a hook
another open PR uses — two PRs adding the same key merge into JSON with a duplicate key and one
test silently disappears. Taken as of 2026-11-24: `pretest:ci` and `posttest:ci` are on `main`
(#357, #358; #395 took #366's place on `posttest:ci`), `posttest:wallet` is claimed by stamped
#397 as well as #363, and `posttest:buzzy-art` (#362) and `posttest:buzzy-jobs` (#372) are still
open. A key on `main` or in an open PR is taken.

## 9. Pushing to the fork

`git push origin <branch>` is refused ("refusing to allow an OAuth App to create or update
workflow … without `workflow` scope") when your branch carries an upstream commit that edits
`.github/workflows` and the fork doesn't have it yet. Find it with
`git log upstream/main --not --remotes=origin -- .github/workflows` and base your branch on that
commit's parent (`git rebase --onto <commit>^ <commit> <branch>`). The pull request still merges
cleanly and CI runs on the merge.

Before pushing a doc or CSS change that other open PRs also touch, check it merges:
`git merge-tree --write-tree --name-only <yours> origin/<theirs>` (exit 0 = clean).
