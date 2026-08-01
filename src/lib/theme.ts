/** Theme packs for the operator UI. Status colors stay distinguishable. */

export type ThemeId = "dark" | "light" | "cyberpunk";

export const THEME_IDS: ThemeId[] = ["dark", "light", "cyberpunk"];

export const THEME_LABELS: Record<ThemeId, string> = {
  dark: "Dark",
  light: "Light",
  cyberpunk: "Cyberpunk",
};

const STORAGE_KEY = "agent-relay-theme";

export function isThemeId(v: unknown): v is ThemeId {
  return v === "dark" || v === "light" || v === "cyberpunk";
}

/** Apply theme to documentElement. Returns the applied id. */
export function applyTheme(id: ThemeId): ThemeId {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = id;
  }
  try {
    if (typeof globalThis !== "undefined" && "localStorage" in globalThis && globalThis.localStorage) {
      globalThis.localStorage.setItem(STORAGE_KEY, id);
    }
  } catch {
    /* node / private mode */
  }
  return id;
}

export function readStoredTheme(): ThemeId {
  try {
    if (typeof globalThis !== "undefined" && "localStorage" in globalThis && globalThis.localStorage) {
      const raw = globalThis.localStorage.getItem(STORAGE_KEY);
      return isThemeId(raw) ? raw : "dark";
    }
  } catch {
    /* ignore */
  }
  return "dark";
}

export function initTheme(): ThemeId {
  return applyTheme(readStoredTheme());
}
