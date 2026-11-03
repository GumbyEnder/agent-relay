# Maintaining Dev Boards / BeeZilla

Written for whoever is holding the merge button — starting with one person, designed so it is not one person forever.

## The deal we offer contributors

We want outside PRs. So we commit to three things publicly:

1. **Every PR gets a human response within 5 working days.** Even "no". Silence is the failure mode we are avoiding.
2. **CI tells the truth.** A green check means typecheck, build, and the hermetic test suite passed on Node 22. Nothing else is claimed.
3. **Small PRs get in first.** A 40-line fix with a test beats a 900-line rewrite, always.

Put those in the README or pin them in Discussions so they are not just tribal knowledge.

## Labels and what they mean

| Label | Meaning | Who acts |
|-------|---------|----------|
| `good first issue` | Self-contained, ~1 file, has a "how to verify" line in the issue | Anyone, no ask needed |
| `help wanted` | We want it, we are not doing it soon | Anyone |
| `needs-repro` | We cannot reproduce; blocked until reporter adds steps | Reporter |
| `needs-design` | Behaviour/UX decision before code | Maintainer writes the decision |
| `protocol` | Touches `/api/agent`, claim semantics, or sealed recipes | Maintainer review required |
| `beezilla` / `devboards` | Which product the change belongs to | Triage only |
| `dependencies` | Bot PR — merge if CI green and changelog looks boring | Maintainer |
| `wontfix` | Closed with a one-paragraph reason | Maintainer |

Every `good first issue` must contain: the file(s), the expected outcome, and the exact command that proves it works. If you cannot write those three, it is not a good first issue.

## Triage flow (15 minutes, twice a week)

1. New issues: label within 48h. Ask for repro on bug reports that lack one — do not guess at a fix.
2. Close duplicates with a link to the canonical issue.
3. Anything security-shaped: redirect to private advisory immediately (see [SECURITY.md](../SECURITY.md)). Do not discuss in the issue thread.
4. Feature requests that expand scope beyond "agents move work on a board" get a polite, specific no — point at [PRODUCT_VISION.md](PRODUCT_VISION.md).
5. Tag 1–2 fresh `good first issue`s per week from the bug backlog. Keeps the on-ramp stocked.

## Reviewing a PR

Blocking checks first — if these fail, say so once and stop reviewing:

- CI `verify` job green
- Diff stays on one concern
- No secrets, `.env`, keys, personal deploy paths
- Behaviour change has a test or a manual-verification note

Then substance:

- Does it work for a single-node self-host (no cloud-only dependency in the happy path)?
- Does it keep `/api/agent` additive? Renaming or removing a field is a `protocol` change.
- Are error paths handled — what happens on empty board, missing key, 409 on claim conflict?
- Does the PR description describe *user-visible* behaviour, not just the diff?

Review comments: say what is wrong and what "done" looks like. "This needs work" without a direction is a dead end for a first-time contributor.

## Merging

- **Squash merge only.** One PR = one commit on `main`. Keeps `main` bisectable and lets us revert cleanly.
- PR title becomes the commit subject — enforce a readable title (imperative, no "fix stuff").
- Delete the branch after merge.
- `main` stays runnable: if a merge breaks `npm run verify`, revert first, debug after. Do not stack a fix on a broken main while contributors are rebasing.
- Tag releases from `main` as `v0.x.y`. Self-hosters pin tags, so a tag is a promise that `docker compose up` works at that commit.

## Versioning while on 0.x

- Additive change → patch or minor, either is fine.
- Breaking change to verbs, claim semantics, or response shape → minor bump **plus** a `CHANGELOG.md` entry under "Breaking".
- Anything under `protocol` gets a note in the changelog even when additive.

## What we say no to

Say no quickly and explain the reason in one sentence:

- New required auth providers on the happy path
- Cloud-only multi-tenant features that break single-node self-host
- Drive-by dependency churn without a stated reason
- Scope growth past the board/agent protocol

"No" with a reason keeps contributors. "No" without one loses them.

## Known debt (be honest in the open)

Tracked, visible, and sized so someone can pick it up:

- **ESLint: 25 errors / ~73 warnings.** Mostly `no-useless-escape` and `no-control-regex` in sanitizers where the control-char regexes are deliberate. CI runs lint as advisory until this is burned down — the fix is inline `eslint-disable-next-line` with a one-line justification where intentional, real fixes elsewhere. Good first issue material.
- **`test:ci` is the hermetic subset.** Browser/Playwright and live-key paths (`test:api`, `test:buzzy-jobs`, `test:webpage-routing`) are not in CI — they need a running server, a render provider, or real keys. Do not claim they are covered.

## Adding a maintainer

When someone lands 3+ substantive PRs and reviews competently: add them to `.github/CODEOWNERS`, give triage rights, and hand them one area to own end-to-end. Maintainer access without an owned area is decoration.
