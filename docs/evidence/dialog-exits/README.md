# Dialog exits at 360px — evidence for #361

Two panels whose only pointer exit is a named button (no X), captured at 360px,
signed in, on a production build of `63a0278`:

| file | panel | pointer exit |
|---|---|---|
| `360-purchase-dialog.png` | `/buzzy/recipes` — "Buy this recipe?" | `Cancel` |
| `360-key-dialog.png` | `/buzzy/talk` — AI key dialog | `.ob-x` (the X) |

Both are asserted, not just photographed, by `scripts/probe-no-outside-close.mjs`, which
checks that each exit is inside the viewport, that its centre actually hits it, that a
click closes the panel, and that a press outside does *not* (with any typed text intact).

Measured 2026-11-25, `63a0278`, widths 360 / 390 / 430 / 1366: **100 checks, 0 failures.**

The purchase dialog having no X is correct, not a gap:
`docs/BEEZILLA-SCREEN-RULES.md` §Critical asks for "its own X (or a button that says
Close or Cancel)". Counting controls instead of reading the rule reports a defect in
working code.
