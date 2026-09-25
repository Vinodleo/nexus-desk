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

/**
 * Shows `id` now: the page's colours and the phone's status bar.
 */
export function applyTheme(id: ThemeId): void {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0];
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.bar);
}

/** Shows and saves `id`. */
export function setTheme(id: ThemeId): void {
  applyTheme(id);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {}
}

/**
 * Runs `change` (which switches the theme) so the new look grows as a circle
 * from `from` (the tapped theme, in page pixels) over the old one, where the
 * browser can (the View Transitions API); straight away otherwise, or with
 * reduced motion. Nothing is blended: fading light into dark (each element's
 * colours, or the whole page) passes through a muddy grey half-way.
 */
export function withThemeTransition(change: () => void, from?: { x: number; y: number }): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
  const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (typeof doc.startViewTransition !== "function" || reduced) {
    change();
    return;
  }
  const t = doc.startViewTransition(change);
  const x = from?.x ?? window.innerWidth / 2;
  const y = from?.y ?? window.innerHeight / 2;
  // Far enough to cover the farthest corner.
  const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  void t.ready
    .then(() =>
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 480, easing: "cubic-bezier(0.4, 0, 0.2, 1)", pseudoElement: "::view-transition-new(root)" }
      )
    )
    .catch(() => {});
}
