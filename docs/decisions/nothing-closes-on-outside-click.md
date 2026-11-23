# Nothing closes on an outside click

**Date:** 2026-11-21 · **Status:** decided

**Owner's words:** this is "a fundamental principle of our design".

**Decision:** anything that opens (pop-up, dialog, panel, sidebar) closes only with Esc or its
X, so typed progress is only ever lost on purpose. Boxes and panels can be made bigger or
smaller by dragging a side or corner (owner, 2026-11-22).

**In the code:** the rule and its exceptions in `docs/BEEZILLA-SCREEN-RULES.md`; guard
`scripts/test-no-outside-close.mjs` (in `npm run test:boundary`); `public/buzzy/resize.js`.
