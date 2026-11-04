# Open core: what is in this repository, and what is not

The sealed-recipe marketplace has two halves. This document is the boundary
between them, so that nobody has to infer it from a missing import.

## Open (this repository, MIT)

Everything a buyer or an auditor needs to check a claim:

| Surface | Files |
|---|---|
| `.srb` bundle format, deterministic zip, RFC 8785 canonicalisation | `src/lib/recipe-seal/{bundle,zip,jcs}.ts` |
| Ed25519 signing + `verifyBundle` (self-consistency and signature) | `src/lib/recipe-seal/bundle.ts` |
| Check DSL, compiler, fuel-bounded VM | `src/lib/recipe-checks/*` |
| The verify tier — runs with **no KEK** | `src/lib/recipe-seal/verify.ts` |
| Content-addressed storage contract | `src/lib/recipe-seal/storage.ts` |
| Leak-gate logging (allow-list, not deny-list) | `src/lib/recipe-seal/safe-log.ts` |
| Manifest schema, the public promise and its stated limits | `docs/RECIPE-SEAL.md` |
| Schema | `migrations/0039…0047` |

The verify tier is public on purpose. "Your prose never leaves the server" and
"this bundle was signed by us" are worth something only if a third party can run
the same code. Closing the verifier would turn a protocol into a vendor promise.

## Closed (private: `github.com:GumbyEnder/beezilla-recipes`)

The commercial logic — how a sealed recipe is opened and run, and what it costs:

- `pipeline.ts` — how a sealed recipe becomes a run (prompt shape, leak filter, sealed evaluation)
- `useRecipe.ts` — entitlement → open → one run, and the method never leaving the server
- `registry.ts` — licensing, metering, atomic quota, cost split
- `routes.ts`, `recipes.nitro.ts` — the management plane: publish, license, run, usage
- `deriveRecipe.ts` — reading a method out of the work somebody actually did

## How this tree builds

`scripts/sync-private.mjs` copies the private modules into `src/lib/private/`
(gitignored) and their tests into `scripts/private/` before every build. It runs
from `prebuild` and `pretypecheck`.

Source order: `BZ_PRIVATE_LOCAL_PATH` → the clone at `.private/beezilla-recipes` →
a clone using `BZ_PRIVATE_REPO_TOKEN` (https) or `BZ_PRIVATE_DEPLOY_KEY` (ssh
deploy key, base64) → **stubs**.

A clone with no credential gets `.private-stub/` instead: the tree still typechecks
and still builds, and `/api/recipes*` answers `503 marketplace_disabled`. That is
the honest open-source build.

The commit is pinned in `private.lock.json`. A source that cannot produce that
exact commit is refused rather than substituted, because "what is in production"
has to have an answer.

Production sets `BZ_REQUIRE_PRIVATE=1`, so a deploy that cannot reach the private
repository **fails the build** instead of shipping a marketplace that answers 503.

`scripts/assert-no-private-modules.mjs` fails the build if a synced module is ever
tracked in git or if the private-file sentinel (`BZ-PRIVATE module:`) appears
anywhere under `src/`.

## The limit of this arrangement

Repository privacy protects the source, not the artifact. The BeeZilla desktop
build compiles these modules into `.output/server/index.mjs`, which ships inside
the installer, and an `asar` archive is unpackable. Privacy raises the cost of
copying the design; it does not make the running code unreadable. The parts that
were published before the split stay MIT in history and in forks.
