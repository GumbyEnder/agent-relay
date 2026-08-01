/**
 * Keyboard shortcut map → board actions (pure; UI binds handlers).
 */
export type KeyboardAction =
  | "focus_search"
  | "next_column"
  | "prev_column"
  | "open_live"
  | "open_board"
  | "open_calls"
  | "claim_selected"
  | "move_ready"
  | "move_running"
  | "compact_toggle"
  | "escape";

export interface KeyChord {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export const KEYBOARD_BINDINGS: Array<{ chord: KeyChord; action: KeyboardAction; label: string }> = [
  { chord: { key: "/" }, action: "focus_search", label: "Focus search" },
  { chord: { key: "j" }, action: "next_column", label: "Next column" },
  { chord: { key: "k" }, action: "prev_column", label: "Prev column" },
  { chord: { key: "1" }, action: "open_board", label: "Board view" },
  { chord: { key: "2" }, action: "open_live", label: "Live view" },
  { chord: { key: "3" }, action: "open_calls", label: "Calls view" },
  { chord: { key: "c" }, action: "claim_selected", label: "Claim selected mission" },
  { chord: { key: "r" }, action: "move_ready", label: "Move selected to Ready" },
  { chord: { key: "g" }, action: "move_running", label: "Move selected to Running" },
  { chord: { key: "d" }, action: "compact_toggle", label: "Toggle compact density" },
  { chord: { key: "Escape" }, action: "escape", label: "Close panel" },
];

export function matchKeyboardAction(
  e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; target?: EventTarget | null },
): KeyboardAction | null {
  const t = e.target as HTMLElement | null | undefined;
  const tag = t?.tagName?.toLowerCase();
  const editable =
    tag === "input" || tag === "textarea" || tag === "select" || t?.isContentEditable;
  if (editable && e.key !== "Escape") {
    if (e.key === "/" && tag === "input") return null;
    if (e.key !== "/" || tag === "textarea") return null;
  }

  for (const b of KEYBOARD_BINDINGS) {
    const { chord, action } = b;
    if (e.key !== chord.key && e.key.toLowerCase() !== chord.key.toLowerCase()) continue;
    if (!!chord.ctrl !== e.ctrlKey) continue;
    if (!!chord.meta !== e.metaKey) continue;
    if (!!chord.shift !== e.shiftKey) continue;
    return action;
  }
  return null;
}

export const COLUMN_ORDER = [
  "inbox",
  "ready",
  "running",
  "needs_human",
  "review",
  "done",
  "blocked",
] as const;

export function adjacentColumn(
  current: (typeof COLUMN_ORDER)[number] | string,
  delta: number,
): (typeof COLUMN_ORDER)[number] {
  const idx = COLUMN_ORDER.indexOf(current as (typeof COLUMN_ORDER)[number]);
  const i = idx < 0 ? 0 : idx;
  const next = Math.max(0, Math.min(COLUMN_ORDER.length - 1, i + delta));
  return COLUMN_ORDER[next]!;
}
