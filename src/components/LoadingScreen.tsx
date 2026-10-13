import React, { useEffect, useRef, useState } from "react";
import { prefersReducedMotion, useShown } from "./ledger/motion";

// While the desk opens: dots scattered over the screen fly together, one
// after another, into an N. When the desk is ready (`ready`), a tile grows
// under the N, the dots take the tile's ink and melt into the lettered N, a
// shine crosses it, and the screen fades to the app underneath (`onDone`).
// With reduced motion the icon simply stands there, and the app follows as
// soon as it's ready.

const CELL = 18;

/** The N's dots in the order a pen draws it (up the left, down the diagonal, up the right), in px within its 90×126 box. */
export const N_DOTS: [number, number][] = (() => {
  const pts: [number, number][] = [];
  for (let r = 7; r >= 0; r--) pts.push([0, r]);
  for (let k = 1; k <= 6; k++) pts.push([(5 * k) / 7, k]);
  for (let r = 7; r >= 0; r--) pts.push([5, r]);
  return pts.map(([x, y]) => [x * CELL, y * CELL]);
})();

/** When the dots start flying in, after the screen shows (ms). */
const GATHER_AT_MS = 250;
/** The earliest the ending starts (ms after the screen shows): by then the dots have nearly all landed. */
export const FINALE_EARLIEST_MS = 1000;
/** How long the ending plays before the screen fades (ms), and the fade. */
export const FINALE_MS = 1250;
export const LEAVE_MS = 300;

/** The tile the N sits on, and where the N's box sits inside it. */
const TILE = 176;
const N_LEFT = (TILE - 5 * CELL) / 2;
const N_TOP = (TILE - 7 * CELL) / 2;

/** Loose dots that drift in and fade as the N forms. */
const DUST = 14;

/** A repeatable random sequence, so the dots start in the same places each time. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** Where each dot starts, as an offset from where it ends up: anywhere on the screen. */
function scatter(width: number, height: number) {
  const rnd = seeded(107);
  const spot = () => [(rnd() - 0.5) * (width - 40), (rnd() - 0.5) * (height - 120)] as const;
  const centre = [N_LEFT + 2.5 * CELL, N_TOP + 3.5 * CELL];
  const dots = N_DOTS.map(([x, y]) => {
    const [sx, sy] = spot();
    return { dx: sx - (x + N_LEFT - centre[0]), dy: sy - (y + N_TOP - centre[1]) };
  });
  const dust = Array.from({ length: DUST }, () => {
    const [sx, sy] = spot();
    return { x: centre[0] + sx, y: centre[1] + sy };
  });
  return { dots, dust };
}

/** A scattered dot's colour: mostly the accent, a few up and down. */
const scatteredTone = (i: number) => (i % 5 === 0 ? "bg-gain" : i % 7 === 0 ? "bg-loss" : "bg-accent");

export const LoadingScreen: React.FC<{ message?: string; ready?: boolean; onDone?: () => void }> = ({
  message = "Opening the desk…",
  ready = false,
  onDone,
}) => {
  const [still] = useState(prefersReducedMotion);
  const [start] = useState(scatter(typeof window === "undefined" ? 390 : window.innerWidth, typeof window === "undefined" ? 844 : window.innerHeight));
  const flying = useShown(GATHER_AT_MS);
  const gathered = still || flying;
  const [finale, setFinale] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const openedAt = useRef(Date.now());
  const done = useRef(onDone);
  done.current = onDone;

  // Ready: the ending starts once the dots have (nearly) landed; with reduced motion, straight to the app.
  useEffect(() => {
    if (!ready || finale) return;
    if (still) {
      done.current?.();
      return;
    }
    const t = setTimeout(() => setFinale(true), Math.max(0, FINALE_EARLIEST_MS - (Date.now() - openedAt.current)));
    return () => clearTimeout(t);
  }, [ready, finale, still]);

  useEffect(() => {
    if (!finale) return;
    const fade = setTimeout(() => setLeaving(true), FINALE_MS);
    const end = setTimeout(() => done.current?.(), FINALE_MS + LEAVE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(end);
    };
  }, [finale]);

  // With reduced motion the finished icon stands there from the start.
  const icon = finale || still;
  return (
    <div
      role="status"
      aria-label={finale ? "Ready" : message}
      className={`fixed inset-0 z-[200] bg-canvas text-ink font-ui flex flex-col items-center justify-center gap-6 overflow-hidden transition-opacity duration-300 ${
        leaving ? "opacity-0 pointer-events-none" : ""
      }`}
    >
      <div className="relative shrink-0" style={{ width: TILE, height: TILE }} aria-hidden="true">
        <span
          data-testid="loading-tile"
          className={`absolute inset-0 rounded-[44px] bg-accent overflow-hidden shadow-[0_18px_40px_color-mix(in_srgb,var(--nx-accent)_32%,transparent)] transition-transform duration-[600ms] ease-[cubic-bezier(0.34,1.45,0.64,1)] ${
            icon ? "scale-100" : "scale-0"
          }`}
        >
          {finale && <span className="nx-shine absolute -top-10 -bottom-10 w-12" />}
          <span
            className={`absolute inset-0 flex items-center justify-center font-display text-[116px] leading-none font-semibold text-on-accent transition-[opacity,transform] duration-500 ease-[cubic-bezier(0.34,1.4,0.64,1)] ${
              icon ? `opacity-100 scale-100 ${still ? "" : "delay-[450ms]"}` : "opacity-0 scale-[0.8]"
            }`}
          >
            N
          </span>
        </span>
        {!still &&
          N_DOTS.map(([x, y], i) => (
            <span
              key={i}
              data-testid="n-dot"
              className="absolute w-3 h-3 -ml-1.5 -mt-1.5"
              style={{
                left: N_LEFT + x,
                top: N_TOP + y,
                transform: gathered ? "none" : `translate(${start.dots[i].dx.toFixed(0)}px, ${start.dots[i].dy.toFixed(0)}px)`,
                opacity: finale ? 0 : 1,
                transition: `transform 900ms cubic-bezier(0.34, 1.18, 0.64, 1) ${i * 20}ms, opacity 300ms ease ${finale ? 500 + i * 12 : 0}ms`,
              }}
            >
              <span
                className={`block w-full h-full rounded-full transition-colors duration-300 ${finale ? "bg-on-accent" : gathered ? "bg-accent" : scatteredTone(i)}`}
                style={finale ? { transitionDelay: `${100 + i * 12}ms` } : undefined}
              />
            </span>
          ))}
        {!still &&
          start.dust.map((d, i) => (
            <span
              key={`dust-${i}`}
              data-testid="dust-dot"
              className="absolute w-[7px] h-[7px] -ml-[3.5px] -mt-[3.5px] rounded-full bg-line"
              style={{
                left: d.x,
                top: d.y,
                transform: gathered ? `translate(${((TILE / 2 - d.x) * 0.35).toFixed(0)}px, ${((TILE / 2 - d.y) * 0.35).toFixed(0)}px)` : "none",
                opacity: gathered ? 0 : 1,
                transition: `transform 900ms ease ${i * 30}ms, opacity 600ms ease ${i * 30}ms`,
              }}
            />
          ))}
      </div>
      <div className="min-h-[72px] flex flex-col items-center gap-2">
        <div
          className={`font-display text-[30px] font-semibold transition-[opacity,transform] duration-500 ${
            icon ? `opacity-100 translate-y-0 ${still ? "" : "delay-[600ms]"}` : "opacity-0 translate-y-2.5"
          }`}
        >
          Nexus Desk
        </div>
        <div key={finale ? "ready" : "opening"} className={`text-sm font-medium nx-fade-in ${finale ? "text-gain" : "text-muted"}`}>
          {finale ? "Ready" : message}
        </div>
      </div>
    </div>
  );
};
