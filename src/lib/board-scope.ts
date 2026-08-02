/** Sentinel selectedProjectId for cross-board views (Board, Live, Calls, Agents). */
export const ALL_BOARDS_ID = "__all__";

export const BOARD_SCOPE_STORAGE_KEY = "devboards-board-scope";

/** True only when the user explicitly chose All boards (not "unset"/null). */
export function isAllBoardsScope(projectId: string | null | undefined): boolean {
  return (
    projectId === ALL_BOARDS_ID ||
    projectId === "all" ||
    projectId === "*"
  );
}

/** Normalize API/UI project refs: "all" / "*" / sentinel → unscoped (undefined). */
export function normalizeProjectRef(
  ref: string | null | undefined,
): string | undefined {
  if (ref == null) return undefined;
  const t = ref.trim();
  if (!t || t === "all" || t === "*" || t === ALL_BOARDS_ID) return undefined;
  return t;
}

export function readStoredBoardScope(): string | null {
  try {
    const raw = localStorage.getItem(BOARD_SCOPE_STORAGE_KEY);
    if (!raw) return null;
    if (raw === ALL_BOARDS_ID || raw === "all" || raw === "*") return ALL_BOARDS_ID;
    return raw;
  } catch {
    return null;
  }
}

export function writeStoredBoardScope(id: string | null): void {
  try {
    if (!id) localStorage.removeItem(BOARD_SCOPE_STORAGE_KEY);
    else localStorage.setItem(BOARD_SCOPE_STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}
