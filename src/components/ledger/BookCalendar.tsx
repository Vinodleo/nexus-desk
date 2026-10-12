import React, { useMemo, useRef, useState } from "react";
import type { HistoricalTrade } from "../../types";
import { formatMoney } from "./format";

// Book → Trades, under the month's total: its running total as a line that
// draws itself (slide a finger along it to read any point), and its days,
// each tinted by what it made or lost with the amount under the date;
// tapping a day shows only its trades.

/** A closed trade's day on this phone's calendar: "2026-10-06". */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** A month counted from year 0 (year × 12 + month), so months add and compare. */
export const monthOf = (ms: number): number => {
  const d = new Date(ms);
  return d.getFullYear() * 12 + d.getMonth();
};
/** The first moment of a month counted by `monthOf`. */
export const monthStartMs = (month: number): number => new Date(Math.floor(month / 12), month % 12, 1).getTime();
/** "October 2026". */
export const monthName = (month: number): string =>
  new Date(Math.floor(month / 12), month % 12, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Wed 8 Oct". */
export const weekdayDay = (ms: number): string => {
  const d = new Date(ms);
  return `${WEEKDAY[d.getDay()]} ${d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`;
};
const shortDay = (ms: number) => new Date(ms).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
const shortSymbol = (s: string) => s.replace(/\.US$/, "").replace(/\/INR$/, "");

export interface LinePoint {
  at: number;
  total: number;
  /** The trade that closed there; none at the month's start and end. */
  symbol?: string;
}

/**
 * The month's running total: zero at its start, then after each trade closed
 * in it (oldest first), held to its end (or now, for this month). Null
 * without trades closed in the month.
 */
export function monthLine(trades: HistoricalTrade[], month: number, now: number): LinePoint[] | null {
  const start = monthStartMs(month);
  const dated = trades.filter((t) => t.closedAtMs !== undefined && monthOf(t.closedAtMs) === month).sort((a, b) => a.closedAtMs! - b.closedAtMs!);
  if (dated.length === 0) return null;
  let total = 0;
  const pts: LinePoint[] = [{ at: start, total: 0 }, ...dated.map((t) => ({ at: t.closedAtMs!, total: (total += t.realizedPnl), symbol: t.symbol }))];
  const end = Math.min(monthStartMs(month + 1), now);
  pts.push({ at: Math.max(end, pts[pts.length - 1].at), total });
  return pts;
}

const W = 350;
const H = 110;

/**
 * The month's running total as a line that draws itself, its area faintly
 * filled, the zero line dashed and a dot pulsing where it ends. Sliding a
 * finger (or the pointer) along it shows the total at the nearest close.
 */
export const MonthLine: React.FC<{ trades: HistoricalTrade[]; month: number; now: number }> = ({ trades, month, now }) => {
  const pts = useMemo(() => monthLine(trades, month, now), [trades, month, now]);
  const [at, setAt] = useState<number | null>(null);
  if (!pts) return null;
  const t0 = pts[0].at;
  const span = pts[pts.length - 1].at - t0 || 1;
  const xs = pts.map((p) => ((p.at - t0) / span) * W);
  const values = pts.map((p) => p.total);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const y = (v: number) => 8 + (1 - (v - lo) / (hi - lo || 1)) * (H - 16);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${xs[i].toFixed(1)} ${y(p.total).toFixed(1)}`).join(" ");
  const end = values[values.length - 1];
  const isThisMonth = monthOf(now) === month;
  const scrub = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const fx = ((e.clientX - r.left) / (r.width || 1)) * W;
    let best = 0;
    xs.forEach((x, i) => {
      if (Math.abs(x - fx) < Math.abs(xs[best] - fx)) best = i;
    });
    setAt(best);
  };
  const p = at !== null ? pts[at] : null;
  const pointLabel = (i: number) => {
    const q = pts[i];
    if (q.symbol) return `${weekdayDay(q.at)} · ${shortSymbol(q.symbol)}`;
    return i === 0 ? shortDay(q.at) : isThisMonth ? "Today" : shortDay(q.at - 1);
  };
  return (
    <div className={end >= 0 ? "text-gain" : "text-loss"} data-testid="money-line">
      <div
        className="relative touch-pan-y cursor-crosshair"
        onPointerDown={scrub}
        onPointerMove={scrub}
        onPointerLeave={() => setAt(null)}
        onPointerCancel={() => setAt(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} className="block w-full h-auto overflow-visible" role="img" aria-label="The month's running total, trade by trade">
          <line x1="0" x2={W} y1={y(0)} y2={y(0)} className="stroke-line" strokeDasharray="3 4" />
          <path d={`${d} L${xs[xs.length - 1].toFixed(1)} ${y(lo).toFixed(1)} L0 ${y(lo).toFixed(1)} Z`} fill="currentColor" fillOpacity="0.08" className="nx-fade-in" style={{ animationDelay: "700ms" }} />
          <path d={d} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" pathLength={1} className="nx-draw" />
          <circle cx={xs[xs.length - 1]} cy={y(end)} r="4" fill="currentColor" className="nx-ring" />
          <circle data-testid="money-line-dot" cx={xs[xs.length - 1]} cy={y(end)} r="4" fill="currentColor" className="stroke-surface" strokeWidth="1.5" />
          {p && (
            <>
              <line x1={xs[at!]} x2={xs[at!]} y1="0" y2={H} className="stroke-muted" strokeWidth="1" />
              <circle cx={xs[at!]} cy={y(p.total)} r="5" fill="currentColor" className="stroke-canvas" strokeWidth="2" />
            </>
          )}
        </svg>
        {p && (
          <div
            data-testid="line-scrub"
            aria-live="polite"
            className="absolute top-0 w-[164px] px-2.5 py-1.5 rounded-[10px] bg-surface border border-line shadow-lg text-[11px] text-ink whitespace-nowrap pointer-events-none nx-fade-in"
            style={{ left: `clamp(0px, calc(${((xs[at!] / W) * 100).toFixed(2)}% - 82px), calc(100% - 164px))` }}
          >
            <div className="text-muted truncate">{pointLabel(at!)}</div>
            <div className="font-bold tabular-nums">Month so far {formatMoney(p.total, { signed: true, decimals: 0 })}</div>
          </div>
        )}
      </div>
      <div className="flex justify-between text-[11px] text-muted mt-0.5">
        <span>{shortDay(t0)}</span>
        <span>Slide along the line</span>
        <span>{isThisMonth ? "today" : shortDay(pts[pts.length - 1].at - 1)}</span>
      </div>
    </div>
  );
};

/** What each day's closed trades made, by day. */
export function dayTotals(trades: HistoricalTrade[]): Map<string, { net: number; count: number }> {
  const out = new Map<string, { net: number; count: number }>();
  for (const t of trades) {
    if (t.closedAtMs === undefined) continue;
    const k = localDay(t.closedAtMs);
    const v = out.get(k) ?? { net: 0, count: 0 };
    out.set(k, { net: v.net + t.realizedPnl, count: v.count + 1 });
  }
  return out;
}

/** A month's days in weeks from Monday, with the days of the months either side that fill its first and last weeks. */
export function monthGrid(year: number, month: number): { key: string; day: number; inMonth: boolean }[] {
  // Days before the 1st back to Monday, then the month, then up to Sunday.
  const lead = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  return Array.from({ length: Math.ceil((lead + days) / 7) * 7 }, (_, i) => {
    const d = new Date(year, month, 1 - lead + i);
    return { key: localDay(d.getTime()), day: d.getDate(), inMonth: d.getMonth() === month };
  });
}

/** A day's amount small enough for its square: "+640", "−2.1k", "+1.2L". */
export function shortAmount(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "−" : "+";
  if (a < 1000) return `${sign}${Math.round(a)}`;
  if (a < 100000) return `${sign}${(a / 1000).toFixed(a < 10000 ? 1 : 0)}k`;
  return `${sign}${(a / 100000).toFixed(1)}L`;
}

/**
 * A month's days, each tinted by what it made with the amount under the date.
 * Tap a day to show only its trades (again to show all); a swipe sideways
 * asks for the month before or after.
 */
export const DayCalendar: React.FC<{
  trades: HistoricalTrade[];
  month: number;
  picked: string | null;
  onPick: (day: string | null) => void;
  /** −1 for the month before, 1 for the one after. */
  onSwipe: (dir: -1 | 1) => void;
  now?: number;
}> = ({ trades, month, picked, onPick, onSwipe, now = Date.now() }) => {
  const totals = useMemo(() => dayTotals(trades), [trades]);
  const cells = monthGrid(Math.floor(month / 12), month % 12);
  const prefix = cells.find((c) => c.inMonth)!.key.slice(0, 8);
  const most = Math.max(1, ...[...totals.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => Math.abs(v.net)));
  const today = localDay(now);
  // The new month slides in from the side it came from.
  const slide = useRef({ month, cls: "" });
  if (slide.current.month !== month) slide.current = { month, cls: month > slide.current.month ? "nx-tab-from-right" : "nx-tab-from-left" };
  const startX = useRef<number | null>(null);
  return (
    <section aria-label="Days" className="bg-surface border border-line rounded-[22px] p-3.5 flex flex-col gap-2" data-testid="day-calendar">
      <div className="grid grid-cols-7 gap-1.5 text-[11px] text-muted text-center" aria-hidden="true">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      <div
        key={month}
        className={`grid grid-cols-7 gap-1.5 touch-pan-y ${slide.current.cls}`}
        data-testid="calendar-days"
        onPointerDown={(e) => (startX.current = e.clientX)}
        onPointerUp={(e) => {
          if (startX.current === null) return;
          const dx = e.clientX - startX.current;
          startX.current = null;
          if (dx < -50) onSwipe(1);
          else if (dx > 50) onSwipe(-1);
        }}
        onPointerCancel={() => (startX.current = null)}
      >
        {cells.map((c, i) => {
          if (!c.inMonth) return <span key={c.key} aria-hidden="true" />;
          const v = totals.get(c.key);
          const label = weekdayDay(new Date(`${c.key}T12:00:00`).getTime());
          const style: React.CSSProperties = {
            animationDelay: `${Math.min(i, 41) * 14}ms`,
            background: v
              ? `color-mix(in srgb, var(--nx-${v.net > 0 ? "gain" : "loss"}) ${Math.round(16 + 40 * (Math.abs(v.net) / most))}%, var(--nx-surface))`
              : c.key > today
              ? "transparent"
              : "var(--nx-inset)",
          };
          const cls = `h-11 rounded-xl flex flex-col items-center justify-center gap-px tabular-nums nx-badge-pop transition-transform ${
            c.key > today ? "text-muted opacity-50" : "text-ink"
          } ${c.key === today ? "ring-[1.5px] ring-inset ring-muted" : ""} ${picked === c.key ? "ring-2 ring-accent scale-110 relative z-10" : ""}`;
          const inner = (
            <>
              <span className="text-[13px] font-semibold leading-none">{c.day}</span>
              {v && <span className="text-[9px] font-semibold leading-none opacity-85">{shortAmount(v.net)}</span>}
            </>
          );
          return v ? (
            <button
              key={c.key}
              type="button"
              aria-pressed={picked === c.key}
              aria-label={`${label}: ${formatMoney(v.net, { signed: true, decimals: 0 })}, ${v.count} ${v.count === 1 ? "trade" : "trades"}`}
              onClick={() => onPick(picked === c.key ? null : c.key)}
              className={`${cls} cursor-pointer`}
              style={style}
              data-testid={`day-${c.key}`}
              data-tone={v.net > 0 ? "gain" : "loss"}
            >
              {inner}
            </button>
          ) : (
            <span key={c.key} className={cls} style={style} data-testid={`day-${c.key}`}>
              {inner}
            </span>
          );
        })}
      </div>
    </section>
  );
};
