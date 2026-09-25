// The app's colour theme, chosen in Settings and kept on this device. Each
// theme is a block of the colour tokens in index.css (html[data-theme]);
// index.html applies the saved one before the app draws, so it never
// flashes the default first.

export type ThemeId = "ivory" | "graphite" | "blush";

export interface ThemeOption {
  id: ThemeId;
  name: string;
  hint: string;
  /** For the picker's preview: background, card, accent. */
  swatch: { canvas: string; surface: string; line: string; accent: string };
  /** The phone's status bar colour. */
  bar: string;
}

export const THEMES: ThemeOption[] = [
  { id: "ivory", name: "Ivory", hint: "Light", swatch: { canvas: "#F6F3EE", surface: "#FFFFFF", line: "#E4DED3", accent: "#1F4E79" }, bar: "#F6F3EE" },
  { id: "graphite", name: "Graphite", hint: "Dark", swatch: { canvas: "#141311", surface: "#1D1C19", line: "#35322D", accent: "#8FB9E6" }, bar: "#141311" },
  { id: "blush", name: "Blush", hint: "Pink", swatch: { canvas: "#FBF0F2", surface: "#FFFFFF", line: "#F0D4DA", accent: "#B0406E" }, bar: "#FBF0F2" },
];

export const THEME_STORAGE_KEY = "nexus_theme";

export function isThemeId(v: unknown): v is ThemeId {
  return THEMES.some((t) => t.id === v);
}

/** The saved theme, Ivory if none (or storage is unavailable). */
export function loadTheme(): ThemeId {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeId(saved) ? saved : "ivory";
  } catch {
    return "ivory";
  }
}

let fadeTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Shows `id` now: the page's colours and the phone's status bar. With
 * `fade`, the colours cross-fade for a moment instead of jumping (not with
 * reduced motion).
 */
export function applyTheme(id: ThemeId, opts: { fade?: boolean } = {}): void {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0];
  const root = document.documentElement;
  const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (opts.fade && !reduced && root.dataset.theme !== theme.id) {
    root.classList.add("nx-theme-fade");
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => root.classList.remove("nx-theme-fade"), 450);
  }
  root.dataset.theme = theme.id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.bar);
}

/** Shows and saves `id`. */
export function setTheme(id: ThemeId): void {
  applyTheme(id, { fade: true });
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {}
}
