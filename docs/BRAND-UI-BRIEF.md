# BeeZilla UI Design Brief — Dev Boards / agent-relay

Source of truth: the BeeZilla brand site (we own it) — final design folds and
mascot assets are vendored in `public/brand/beezilla/`.

## Assets (already vendored)
- `public/brand/beezilla/expressions/01-love.png … 21-dizzy.png` — mascot
  expression set. Map to UI states:
  - `11-loading.png` → loading/heartbeat spinner
  - `08-thinking.png` → review / analysis
  - `12-content.png` → idle success
  - `16-smiling.png` → default/empty states
  - `17-attentive.png` → agent running
  - `18-unimpressed.png` → validation errors / bounce
  - `19-angry.png` → failed mission / needs_human
  - `15-neutral.png` → neutral chrome
- `public/brand/beezilla/character-sheet.png` — full mascot reference.
- `public/brand/beezilla/journey/fold-0{1,2,3}-final.png` — approved design
  folds: hero split, 5-step explainer, board + subscription footer.
- `journey/boards_board.webp` — approved kanban board treatment.

## Design language (from the approved folds)
- **Surfaces:** deep charcoal/near-black (`#0A0A0A` page, `#141414` panels,
  `#1A1A1A` columns). Light sections are stark white `#FFFFFF` — use the
  alternating dark/light row rhythm for long explainer pages.
- **Accent:** electric bee-yellow `#FFC107` (CTAs, step numbers, column trim,
  links, active states). One accent only — no gradient rainbows.
- **Status colors on cards:** blue = in progress, lavender = review,
  green = done, red = needs_human. Muted, never saturated.
- **Motifs:** hexagon markers/badges (step numbers, status icons), subtle
  circuit-line corner decorations at very low opacity. Yellow 'X' hex = pain
  point; solid hex = positive.
- **Cards ("riveted metal"):** brushed-silver gradient card with beveled edge
  and 4 corner rivets, dark text. Use sparingly (board cards, plan tiers) —
  the rest of the UI stays flat dark.
- **Typography:** geometric sans (Inter is fine). Huge tight-kerned headlines
  ("From confusion" / "to clarity" split motif), bold step numbers.
- **Mascot as guide:** BeeZilla appears per state, never as random
  decoration; pointing pose directs to the primary CTA.

## Build notes
- Tailwind tokens: `--bz-black #0A0A0A`, `--bz-panel #141414`,
  `--bz-col #1A1A1A`, `--bz-yellow #FFC107`, `--bz-silver #C9CDD2`,
  `--bz-charcoal #111111`.
- The app currently uses semantic classes (`bg-bg`, `text-fg`,
  `text-fg-muted`, `border-border`, `text-status-*`) defined in the theme
  layer — re-skin the TOKENS, don't hand-paint every component.
- Login/register/auth shells and the board view are the first two surfaces to
  carry the new skin; devboards-web marketing site is a separate follow-up.
