import React, { useEffect, useState } from "react";
import { deskDay, type DeskEvent, type DeskEventId } from "../../shared/deskDay";
import { Card } from "./ui";

// Lab → Today → "The desk's day": a 24-hour dial in India time. Coins trade
// all day (the outer ring of dashes), the US session and NSE's are arcs, and
// the server's scheduled checks are numbered marks on it, with a hand at the
// time now. Under it each one with its next time; tap one to read what it does.

const SIZE = 288;
const C = SIZE / 2;
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "05:40" from minutes after midnight. */
export const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m) % 60).padStart(2, "0")}`;
const deg = (m: number) => (m / 1440) * 360;

/** "in 6 h 9 min", "in 23 min", "in 3 days". */
export function untilText(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m >= 48 * 60) return `in ${Math.round(m / 1440)} days`;
  const h = Math.floor(m / 60);
  return `in ${h ? `${h} h ` : ""}${m % 60} min`;
}

/** A ring of the dial between two radii. */
const ring = (r1: number, r2: number): React.CSSProperties => {
  const mask = `radial-gradient(circle at center, transparent ${r1 - 0.5}px, #000 ${r1}px, #000 ${r2}px, transparent ${r2 + 0.5}px)`;
  return { WebkitMaskImage: mask, maskImage: mask };
};
/** A session's arc, from one India-time minute to another (round midnight if it ends before it starts). */
const arc = (from: number, to: number, color: string) =>
  from < to
    ? `conic-gradient(transparent 0 ${deg(from)}deg, ${color} 0 ${deg(to)}deg, transparent 0), var(--nx-inset)`
    : `conic-gradient(${color} 0 ${deg(to)}deg, transparent 0 ${deg(from)}deg, ${color} 0), var(--nx-inset)`;

const US_COLOR = "var(--nx-accent)";
const NSE_COLOR = "color-mix(in srgb, var(--nx-warn) 60%, transparent)";

const META: Record<DeskEventId, { title: string; color: string; mark?: { n: number; r: number }; text: string }> = {
  "coin-check": {
    title: "Coin check",
    color: "var(--nx-gain)",
    mark: { n: 1, r: 139 },
    text: "Ten minutes after the 00:00 UTC daily close: coin breakout 55/20 buys a close above the 55-day high and sells one below the 20-day low.",
  },
  "us-checks": {
    title: "US checks",
    color: US_COLOR,
    mark: { n: 2, r: 120 },
    text: "At 3:45 pm New York on weekdays: US breakout, then funds breakout, and on the week's last session US momentum. Breakout and momentum sell here too, even with autopilot off.",
  },
  us: {
    title: "US market",
    color: "color-mix(in srgb, var(--nx-accent) 45%, var(--nx-surface))",
    text: "The regular session, 9:30 am to 4 pm New York, in India time. It moves an hour when New York changes its clocks.",
  },
  nse: {
    title: "Indian stocks",
    color: NSE_COLOR,
    text: "Nifty 50 on NSE, weekdays: entries 9:15 to 3:00, every trade closed by 3:20.",
  },
  summary: {
    title: "Weekly summary",
    color: "var(--nx-ink)",
    mark: { n: 3, r: 70 },
    text: "Sunday at 10 am: a pop-up with the week's closed trades and each slower strategy's paper trades against its replay.",
  },
};

function whenText(e: DeskEvent): string {
  if (e.id === "coin-check") return `${hm(e.at)} every day`;
  if (e.id === "us-checks") return `${hm(e.at)} on US weekdays`;
  if (e.id === "summary") return `Sunday ${hm(e.at)}`;
  return `${hm(e.at)} to ${hm(e.until ?? e.at)}, weekdays`;
}

export const DeskDayCard: React.FC<{ now?: number }> = ({ now: fixedNow }) => {
  const [tick, setTick] = useState(() => fixedNow ?? Date.now());
  useEffect(() => {
    if (fixedNow !== undefined) return setTick(fixedNow);
    const t = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [fixedNow]);
  const now = fixedNow ?? tick;
  // The hand swings round from midnight to the time when first shown.
  const [swung, setSwung] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSwung(true), 60);
    return () => clearTimeout(t);
  }, []);

  const day = deskDay(now);
  const checks = day.events.filter((e) => e.id === "coin-check" || e.id === "us-checks");
  const soonest = checks.reduce((a, b) => (b.nextAt < a.nextAt ? b : a)).id;
  const [picked, setPicked] = useState<DeskEventId | null>(null);
  const on = picked ?? soonest;
  const ev = (id: DeskEventId) => day.events.find((e) => e.id === id)!;
  const us = ev("us");
  const nse = ev("nse");
  const dim = (ids: DeskEventId[]) => (ids.includes(on) ? 1 : 0.35);

  return (
    <Card aria-label="The desk's day" className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-sm font-semibold">The desk's day</div>
        <span className="text-xs text-muted">India time</span>
      </div>

      <div className="relative self-center rounded-full bg-surface" style={{ width: SIZE, height: SIZE }} aria-hidden="true" data-testid="desk-dial">
        <div className="absolute inset-0 rounded-full nx-dial-sweep">
          <div className="absolute inset-0 rounded-full overflow-hidden nx-dial-ring" style={{ ...ring(135, 142), opacity: dim(["coin-check"]) }}>
            <div className="absolute inset-0 nx-dial-flow" style={{ background: "repeating-conic-gradient(var(--nx-gain) 0 2.2deg, transparent 0 7.5deg)" }} />
          </div>
          <div
            className="absolute inset-0 rounded-full nx-dial-ring"
            data-testid="dial-us"
            style={{ ...ring(112, 128), background: arc(us.at, us.until!, US_COLOR), opacity: dim(["us", "us-checks"]) }}
          />
          <div
            className="absolute inset-0 rounded-full nx-dial-ring"
            data-testid="dial-nse"
            style={{ ...ring(92, 106), background: arc(nse.at, nse.until!, NSE_COLOR), opacity: dim(["nse"]) }}
          />
          <div className="absolute inset-0 rounded-full" style={{ ...ring(79, 84), background: "repeating-conic-gradient(var(--nx-line) 0 1deg, transparent 0 15deg)" }} />
        </div>
        {(
          [
            ["midnight", C, C - 62],
            ["6 am", C + 62, C],
            ["noon", C, C + 62],
            ["6 pm", C - 62, C],
          ] as const
        ).map(([label, x, y]) => (
          <span key={label} className="absolute -translate-x-1/2 -translate-y-1/2 text-[10px] font-semibold text-muted" style={{ left: x, top: y }}>
            {label}
          </span>
        ))}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-display text-[32px] leading-none tabular-nums" data-testid="dial-clock">
            {hm(day.minutes)}
          </span>
          <span className="text-[11px] text-muted mt-1">{DAYS[day.weekday]}</span>
        </div>
        <div className="absolute inset-0 nx-dial-hand" data-testid="dial-hand" style={{ transform: `rotate(${swung ? deg(day.minutes) : 0}deg)` }}>
          <span
            className="absolute left-1/2 top-[10px] bottom-[calc(50%+46px)] w-0.5 -ml-px rounded-full"
            style={{ background: "linear-gradient(to top, transparent, var(--nx-ink) 30%)" }}
          />
          <span className="absolute left-1/2 top-1 w-3 h-3 -ml-1.5 rounded-full bg-ink nx-ring" />
          <span className="absolute left-1/2 top-1 w-3 h-3 -ml-1.5 rounded-full bg-ink ring-4 ring-surface" />
        </div>
        {day.events
          .filter((e) => META[e.id].mark)
          .map((e, i) => {
            const m = META[e.id].mark!;
            return (
              <div key={e.id} className="absolute inset-0 pointer-events-none" style={{ transform: `rotate(${deg(e.at)}deg)` }}>
                <div
                  className="absolute left-1/2 w-6 h-6 -ml-3 -mt-3"
                  style={{ top: C - m.r, transform: `rotate(${-deg(e.at)}deg)` }}
                  data-testid={`dial-mark-${e.id}`}
                >
                  {e.id === soonest && <span className="absolute inset-0 rounded-full nx-ring" style={{ background: META[e.id].color }} />}
                  <span
                    className={`absolute inset-0 rounded-full border-2 border-surface grid place-items-center text-[10px] font-bold text-surface nx-badge-pop transition-transform duration-300 ${
                      e.id === on ? "scale-125" : ""
                    }`}
                    style={{ background: META[e.id].color, animationDelay: `${1300 + i * 140}ms` }}
                  >
                    {m.n}
                  </span>
                </div>
              </div>
            );
          })}
      </div>

      <div className="flex flex-col" role="group" aria-label="The day's sessions and checks">
        {day.events.map((e) => {
          const meta = META[e.id];
          const session = e.until !== undefined;
          const status = session && e.open ? "open now" : `${session ? "opens " : ""}${untilText(e.nextAt - now)}`;
          return (
            <button
              key={e.id}
              type="button"
              aria-pressed={e.id === on}
              onClick={() => setPicked(e.id)}
              data-testid={`day-${e.id}`}
              className={`flex items-center gap-3 min-h-12 px-3 -mx-1 rounded-2xl text-left cursor-pointer transition-colors ${e.id === on ? "bg-accent-soft" : ""}`}
            >
              <span className="w-3 h-3 rounded-[4px] shrink-0" style={{ background: meta.color }} />
              <span className="flex-1 min-w-0 flex flex-col">
                <span className="text-sm font-semibold">
                  {meta.mark ? `${meta.mark.n} · ` : ""}
                  {meta.title}
                </span>
                <span className="text-xs text-muted tabular-nums">{whenText(e)}</span>
              </span>
              <span className={`text-xs font-semibold tabular-nums whitespace-nowrap ${session && e.open ? "text-gain" : "text-muted"}`}>{status}</span>
            </button>
          );
        })}
      </div>
      <p key={on} className="m-0 text-xs text-muted leading-relaxed nx-row-in" data-testid="day-about">
        {META[on].text}
      </p>
    </Card>
  );
};
