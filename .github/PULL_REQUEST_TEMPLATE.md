<!--
Thanks for the PR. Keep it small and one concern. Delete sections that do not apply.
-->

## What this changes

<!-- One or two sentences a user would understand. -->

## Why

<!-- The problem, issue, or use case. Link it: Fixes #123 -->

## Which product

- [ ] Dev Boards (board, `/api/agent`, operator UI, self-host)
- [ ] BeeZilla (`/buzzy/*`, consumer journey, documents, memory)
- [ ] Shared engine / docs / tooling (both)

## How I verified it

<!-- Pasted command output beats a description. -->

```
npm run typecheck
npm run test:ci
```

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` introduces no **new** errors in the files I touched
- [ ] `npm run build` passes
- [ ] `npm run test:ci` passes
- [ ] Manual check done (say what you did)

## Risk / compatibility

- [ ] No behaviour change
- [ ] Behaviour change (describe the user-visible difference)
- [ ] Breaking change to `/api/agent` or claim semantics — `CHANGELOG.md` updated

## Scope check

- [ ] No `.env`, secrets, keys, or personal deployment paths in the diff
- [ ] No drive-by dependency upgrades or unrelated reformatting
- [ ] Tests added or updated where behaviour changed
