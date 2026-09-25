import React, { useEffect, useReducer, useRef, useState } from "react";

// Small motion helpers shared by the Floor, the sheets and the notices. All
// the movement itself is CSS (index.css, the nx-* classes); these decide
// when it plays. Everything settles at once with reduced motion.

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

const canAnimate = () => !prefersReducedMotion() && typeof requestAnimationFrame === "function";

/**
 * A number that glides to each new value over `ms` instead of jumping.
 * Starts at `from` (default: the first value, so nothing moves on first show).
 */
export function useAnimatedNumber(value: number, ms = 450, from?: number): number {
  const target = Number.isFinite(value) ? value : 0;
  const [shown, setShown] = useState(() => (from === undefined || !canAnimate() ? target : from));
  const shownRef = useRef(shown);
  shownRef.current = shown;

  useEffect(() => {
    const start = shownRef.current;
    if (start === target || !canAnimate()) {
      setShown(target);
      return;
    }
    const t0 = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      setShown(t >= 1 ? target : start + (target - start) * (1 - Math.pow(1 - t, 3)));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);

  return shown;
}

/** "up" or "down" when the value last moved, with a key that changes on each move so the flash replays. */
export function useFlash(value: number): { dir: "up" | "down" | null; key: number } {
  const prev = useRef(value);
  const [flash, setFlash] = useState<{ dir: "up" | "down" | null; key: number }>({ dir: null, key: 0 });
  useEffect(() => {
    const before = prev.current;
    prev.current = value;
    if (!Number.isFinite(before) || !Number.isFinite(value) || value === before) return;
    setFlash((f) => ({ dir: value > before ? "up" : "down", key: f.key + 1 }));
  }, [value]);
  return flash;
}

/** A figure that tints green or red for a moment when it moves. The tint is an overlay, so the figure itself isn't remounted. */
export const Flash: React.FC<{ value: number; className?: string; children: React.ReactNode }> = ({ value, className = "", children }) => {
  const { dir, key } = useFlash(value);
  return (
    <span className={`relative ${className}`} data-flash={dir ?? undefined}>
      {dir && <span key={key} aria-hidden="true" className={`absolute inset-0 rounded-[4px] pointer-events-none nx-flash-${dir}`} />}
      {children}
    </span>
  );
};

/** Keeps something mounted for `ms` after it closes, so it can animate out. */
export function usePresence(open: boolean, ms = 220): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    if (prefersReducedMotion()) {
      setMounted(false);
      return;
    }
    const t = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(t);
  }, [open, ms, mounted]);
  return { mounted: open || mounted, leaving: !open && mounted };
}

export type ListItemState = "enter" | "stay" | "leave";

/**
 * A list that keeps removed items for `ms` in their old place, marked
 * "leave", so they can animate out; items added after the first show are
 * marked "enter" (for good: the class stays put, so its animation plays once).
 */
export function usePresenceList<T>(items: T[], keyOf: (item: T) => string, ms = 320): { item: T; key: string; state: ListItemState }[] {
  const initial = useRef<Set<string> | null>(null);
  const prev = useRef<{ item: T; key: string }[]>([]);
  const leaving = useRef(new Map<string, { item: T; index: number; until: number }>());
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  const keyed = items.map((item) => ({ item, key: keyOf(item) }));
  if (initial.current === null) initial.current = new Set(keyed.map((e) => e.key));
  const current = new Set(keyed.map((e) => e.key));
  const now = Date.now();

  if (!prefersReducedMotion()) {
    prev.current.forEach((e, index) => {
      if (!current.has(e.key) && !leaving.current.has(e.key)) leaving.current.set(e.key, { item: e.item, index, until: now + ms });
    });
  }
  for (const [key, l] of leaving.current) if (current.has(key) || l.until <= now) leaving.current.delete(key);

  const out: { item: T; key: string; state: ListItemState }[] = keyed.map((e) => ({
    ...e,
    state: initial.current!.has(e.key) ? "stay" : "enter",
  }));
  [...leaving.current]
    .sort((a, b) => a[1].index - b[1].index)
    .forEach(([key, l]) => out.splice(Math.min(l.index, out.length), 0, { item: l.item, key, state: "leave" }));

  useEffect(() => {
    prev.current = keyed;
    if (leaving.current.size === 0) return;
    const wait = Math.max(0, Math.min(...[...leaving.current.values()].map((l) => l.until)) - Date.now());
    const t = setTimeout(rerender, wait + 5);
    return () => clearTimeout(t);
  });

  return out;
}

/** A number shown through `format` that glides to each new value. */
export const Rolling: React.FC<{ value: number; format: (n: number) => string; ms?: number }> = ({ value, format, ms }) => (
  <>{format(useAnimatedNumber(value, ms))}</>
);
