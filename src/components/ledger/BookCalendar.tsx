import React, { useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { HistoricalTrade } from "../../types";
import { formatMoney } from "./format";

// Book → Trades, above the list: the money line (the running total of closed
// trades, drawn left to right) and a month of days, each tinted by what it
// made or lost; tapping a day shows only its trades.

/** A closed trade's day on this phone's calendar: "2026-10-06". */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The running total after each closed trade, oldest first, starting from zero; null with fewer than two trades. */
export function moneyLine(trades: HistoricalTrade[]): { at: number; total: number }[] | null {
  const dated = trades.filter((t) => t.closedAtMs !== undefined).sort((a, b) => a.closedAtMs! - b.closedAtMs!);
  if (dated.length < 2) return null;
  let total = 0;
  return [{ at: dated[0].closedAtMs!, total: 0 }, ...dated.map((t) => ({ at: t.closedAtMs!, total: (total += t.realizedPnl) }))];
}

const MONTH = (y: number, m: number) => new Date(y, m, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
const SHORT_DAY = (ms: number) => new Date(ms).toLocaleDateString("en-IN", { day: "numeric", month: "short" });

/** The running total as a line that draws itself, with the zero line dashed and a pulsing dot where it stands now. */
export const MoneyLine: React.FC<{ trades: HistoricalTrade[] }> = ({ trades }) => {
  const pts = useMemo(() => moneyLine(trades), [trades]);
  if (!pts) return null;
  const W = 300;
  const H = 72;
  const values = pts.map((p) => p.total);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  const span = hi - lo || 1;
  // Evenly spaced by trade, so a busy day doesn't squash into a sliver.
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const y = (v: number) => 4 + (1 - (v - lo) / span) * (H - 8);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.total).toFixed(1)}`).join(" ");
  const end = values[values.length - 1];
  return (
    <div className={end >= 0 ? "text-gain" : "text-loss"} data-testid="money-line">
      <div className="relative h-[72px] pr-1.5">
        <div className="h-full nx-reveal">
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block w-full h-full" aria-label="The running total of closed trades">
            <line x1="0" x2={W} y1={y(0)} y2={y(0)} className="stroke-line" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
            <path d={d} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
        <span data-testid="money-line-dot" className="absolute right-0 w-2.5 h-2.5 -mt-[5px] rounded-full bg-current" style={{ top: `${(y(end) / H) * 100}%` }}>
          <span aria-hidden="true" className="absolute inset-0 rounded-full bg-current nx-ring" />
        </span>
      </div>
      <div className="flex justify-between text-[11px] text-muted mt-1">
        <span>{SHORT_DAY(pts[0].at)}</span>
        <span>after each closed trade</span>
        <span>{SHORT_DAY(pts[pts.length - 1].at)}</span>
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

const monthIndex = (ms: number) => {
  const d = new Date(ms);
  return d.getFullYear() * 12 + d.getMonth();
};

/**
 * A month of days tinted by what they made, opening on this month; the arrows
 * or a swipe go to any month. Tap a day to show only its trades (again to show all).
 */
export const DayCalendar: React.FC<{
  trades: HistoricalTrade[];
  picked: string | null;
  onPick: (day: string | null) => void;
  now?: number;
}> = ({ trades, picked, onPick, now = Date.now() }) => {
  const totals = useMemo(() => dayTotals(trades), [trades]);
  const hasTrades = trades.some((t) => t.closedAtMs !== undefined);
  // Opens on this month; the arrows (or a swipe) go to any month, earlier or later.
  const thisMonth = monthIndex(now);
  const [month, setMonth] = useState(thisMonth);
  const year = Math.floor(month / 12);
  const cells = monthGrid(year, month % 12);
  const most = Math.max(1, ...[...totals.values()].map((v) => Math.abs(v.net)));
  const today = localDay(now);
  // The month's own total, from its days.
  const prefix = `${year}-${String((month % 12) + 1).padStart(2, "0")}-`;
  const monthTotal = [...totals.entries()].filter(([k]) => k.startsWith(prefix)).reduce((a, [, v]) => ({ net: a.net + v.net, count: a.count + v.count }), { net: 0, count: 0 });
  // The new month slides in from the side it came from.
  const slide = useRef({ month, cls: "" });
  if (slide.current.month !== month) slide.current = { month, cls: month > slide.current.month ? "nx-tab-from-right" : "nx-tab-from-left" };
  const startX = useRef<number | null>(null);
  if (!hasTrades) return null;
  return (
    <section aria-label="Days" className="bg-surface border border-line rounded-[22px] p-3.5 flex flex-col gap-2" data-testid="day-calendar">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          aria-label="Earlier month"
          onClick={() => setMonth(month - 1)}
          className="w-11 h-11 rounded-full grid place-items-center text-ink cursor-pointer"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div key={month} className="flex flex-col items-center nx-roll-in">
          <div className="text-sm font-semibold" data-testid="calendar-month">
            {MONTH(year, month % 12)}
          </div>
          <div className="text-[11px] text-muted tabular-nums" data-testid="calendar-month-total">
            {monthTotal.count === 0 ? (
              "No closed trades"
            ) : (
              <>
                <span className={monthTotal.net > 0 ? "text-gain" : monthTotal.net < 0 ? "text-loss" : ""}>
                  {formatMoney(monthTotal.net, { signed: true, decimals: 0 })}
                </span>{" "}
                · {monthTotal.count} {monthTotal.count === 1 ? "trade" : "trades"}
              </>
            )}
          </div>
        </div>
        <button
          type="button"
          aria-label="Later month"
          onClick={() => setMonth(month + 1)}
          className="w-11 h-11 rounded-full grid place-items-center text-ink cursor-pointer"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
      {month !== thisMonth && (
        <button
          type="button"
          onClick={() => setMonth(thisMonth)}
          className="self-center min-h-8 px-3 rounded-full border border-line text-xs font-semibold text-accent cursor-pointer nx-badge-pop"
        >
          Back to this month
        </button>
      )}
      <div className="grid grid-cols-7 gap-[5px] text-[10px] font-semibold text-muted text-center" aria-hidden="true">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <span key={i}>{d}</span>
        ))}
      </div>
      <div
        key={month}
        className={`grid grid-cols-7 gap-[5px] touch-pan-y ${slide.current.cls}`}
        data-testid="calendar-days"
        // A swipe sideways moves a month, like the arrows.
        onPointerDown={(e) => (startX.current = e.clientX)}
        onPointerUp={(e) => {
          if (startX.current === null) return;
          const dx = e.clientX - startX.current;
          startX.current = null;
          if (dx < -50) setMonth(month + 1);
          else if (dx > 50) setMonth(month - 1);
        }}
        onPointerCancel={() => (startX.current = null)}
      >
        {cells.map((c, i) => {
          const v = totals.get(c.key);
          const mix = v ? Math.round(18 + 52 * (Math.abs(v.net) / most)) : 0;
          const label = new Date(`${c.key}T12:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
          const style: React.CSSProperties = {
            animationDelay: `${Math.min(i, 41) * 14}ms`,
            background: v ? `color-mix(in srgb, var(--nx-${v.net > 0 ? "gain" : "loss"}) ${mix}%, var(--nx-surface))` : "var(--nx-inset)",
          };
          const cls = `aspect-square rounded-[10px] grid place-items-center text-xs font-semibold tabular-nums nx-badge-pop transition-transform ${
            c.inMonth ? "text-ink" : "text-muted"
          } ${c.key > today ? "opacity-40" : ""} ${c.key === today ? "ring-2 ring-inset ring-ink" : ""} ${
            picked === c.key ? "outline-2 outline-offset-2 outline-accent scale-110 relative z-10" : ""
          }`;
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
              {c.day}
            </button>
          ) : (
            <span key={c.key} className={cls} style={style} data-testid={`day-${c.key}`}>
              {c.day}
            </span>
          );
        })}
      </div>
      <div className="flex justify-center gap-4 text-[11px] text-muted" aria-hidden="true">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: "color-mix(in srgb, var(--nx-gain) 55%, var(--nx-surface))" }} />
          made money
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: "color-mix(in srgb, var(--nx-loss) 45%, var(--nx-surface))" }} />
          lost money
        </span>
        <span>tap a day for its trades</span>
      </div>
    </section>
  );
};
