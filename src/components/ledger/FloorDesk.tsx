import React, { useEffect, useState } from "react";
import type { Position } from "../../types";
import { DEFAULT_MARKET_LIMITS, marketOf, slotKindOf, slotsFor, type MarketKey, type MarketLimits, type SlotKind } from "../../shared/marketLimits";
import { IST_OFFSET_MS } from "../../shared/nse";
import { deskDay, type DeskEventId } from "../../shared/deskDay";
import { freeCash, moneyInTrades } from "../../shared/paperCash";
import { formatMoney } from "./format";
import { Rolling } from "./motion";
import { Card } from "./ui";

// The Floor's newer parts: the open trades grouped by the strategy that holds
// them (each slower strategy on its own slots), the money ring split the same
// way, and what the desk does next.

export type FloorGroupId = "us-breakout" | "funds" | "us-momentum" | "coin-breakout" | "coin-momentum" | "nse-breakout" | "nse-momentum" | "other";

interface GroupDef {
  id: FloorGroupId;
  market: MarketKey | null;
  kind: SlotKind;
  label: string;
  /** Its name on its card, when longer than `label`. */
  title?: string;
  /** Its name on the strategy tabs. */
  short: string;
  /** Its colour on the money ring. */
  color: string;
  opacity: number;
}

const GROUPS: GroupDef[] = [
  { id: "us-breakout", market: "us", kind: "breakout", label: "US breakout", short: "Breakout", color: "var(--color-accent)", opacity: 1 },
  { id: "funds", market: "us", kind: "funds", label: "Funds breakout", short: "Funds", color: "var(--color-accent)", opacity: 0.66 },
  { id: "us-momentum", market: "us", kind: "momentum", label: "US momentum", title: "US momentum · top 3", short: "Top 3", color: "var(--color-accent)", opacity: 0.4 },
  { id: "coin-breakout", market: "coins", kind: "breakout", label: "Coin breakout", short: "Coins", color: "var(--color-warn)", opacity: 1 },
  { id: "coin-momentum", market: "coins", kind: "momentum", label: "Coin momentum", short: "Coin mom.", color: "var(--color-warn)", opacity: 0.55 },
  { id: "nse-breakout", market: "stocks", kind: "breakout", label: "India breakout", short: "India", color: "var(--color-gain)", opacity: 1 },
  { id: "nse-momentum", market: "stocks", kind: "momentum", label: "India momentum", short: "India mom.", color: "var(--color-gain)", opacity: 0.55 },
  { id: "other", market: null, kind: null, label: "5-minute and daily trades", short: "Others", color: "var(--color-muted)", opacity: 0.6 },
];

export interface FloorGroup extends GroupDef {
  /** Its own slots (none for the other trades, which count against each market's trades at once). */
  slots: number | null;
  positions: Position[];
  /** What its open paper trades tie up. */
  inTrades: number;
}

/** Which group holds a trade: its slower strategy's in its market, else the others. */
export function floorGroupOf(p: Pick<Position, "symbol" | "strategy">): FloorGroupId {
  const kind = slotKindOf(p);
  if (!kind) return "other";
  const market = marketOf(p.symbol);
  return GROUPS.find((g) => g.market === market && g.kind === kind)?.id ?? "other";
}

/**
 * The open trades by group, in a fixed order: each slower strategy with slots
 * of its own (shown even when empty, as it's waiting for its next check), and
 * the other trades when there are any.
 */
export function floorGroups(positions: Position[], limits: MarketLimits = DEFAULT_MARKET_LIMITS): FloorGroup[] {
  return GROUPS.map((g) => {
    const held = positions.filter((p) => floorGroupOf(p) === g.id);
    const slots = g.market && g.kind ? slotsFor(limits[g.market], g.kind) : null;
    return { ...g, slots, positions: held, inTrades: moneyInTrades(held) };
  }).filter((g) => g.positions.length > 0 || (g.slots ?? 0) > 0);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A moment in India's time: "5:40", "am", "Mon". */
export function istClock(ms: number): { time: string; half: "am" | "pm"; day: string } {
  const d = new Date(ms + IST_OFFSET_MS);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  return { time: `${h % 12 || 12}:${String(m).padStart(2, "0")}`, half: h < 12 ? "am" : "pm", day: DAYS[d.getUTCDay()] };
}

/** How long until a moment: "in 3 h 35 m", "in 42 m", "in 4:05" in the last 5 minutes. */
export function untilText(ms: number, now: number): string {
  const s = Math.max(0, Math.round((ms - now) / 1000));
  if (s < 300) return `in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const mins = Math.round(s / 60);
  if (mins < 60) return `in ${mins} m`;
  return `in ${Math.floor(mins / 60)} h ${mins % 60} m`;
}

const EVENT_TEXT: Record<DeskEventId, { title: string; sub: string }> = {
  "coin-check": { title: "Coin breakout check", sub: "The day's close on this year's 20 biggest coins: buys any above its 55-day high" },
  "us-checks": { title: "US checks", sub: "Breakout and the funds at 3:45 pm New York; momentum on the week's last session" },
  nse: { title: "India opens", sub: "The 5-minute scanner watches the Nifty 50" },
  us: { title: "US opens", sub: "The 5-minute scanner watches US stocks" },
  summary: { title: "Weekly summary", sub: "The week's trades in a pop-up" },
};

export interface DeskStep {
  id: DeskEventId;
  at: number;
  title: string;
  sub: string;
}

/** What the desk does next, soonest first: its checks and the markets opening (not a market open now). */
export function nextOnDesk(now: number, count = 3): DeskStep[] {
  return deskDay(now)
    .events.filter((e) => !e.open)
    .map((e) => ({ id: e.id, at: e.nextAt, ...EVENT_TEXT[e.id] }))
    .sort((a, b) => a.at - b.at)
    .slice(0, count);
}

/** The time now, updated every `ms` (fixed when `fixed` is given, for tests). */
export function useNow(ms: number, fixed?: number): number {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined) return setNow(fixed);
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, fixed]);
  return fixed ?? now;
}

/** "Next on the desk": the next checks and openings in India time, the first counting down. */
export const NextOnDesk: React.FC<{ now?: number }> = ({ now: fixed }) => {
  const now = useNow(1000, fixed);
  const steps = nextOnDesk(now);
  return (
    <Card aria-label="Next on the desk" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="m-0 text-sm font-semibold">Next on the desk</h2>
        <span className="text-xs text-muted">India time</span>
      </div>
      <ol className="list-none m-0 p-0 flex flex-col gap-3">
        {steps.map((s, i) => {
          const c = istClock(s.at);
          return (
            <li key={s.id} data-testid="desk-step" className="flex gap-3 items-start nx-step-in" style={{ animationDelay: `${i * 70}ms` }}>
              <div className="w-14 shrink-0 tabular-nums">
                <div className="font-display text-[17px] leading-tight">{c.time}</div>
                <div className="text-[11px] text-muted">
                  {c.day} {c.half}
                </div>
              </div>
              <div className={`flex-1 min-w-0 pb-3 ${i < steps.length - 1 ? "border-b border-line" : ""}`}>
                <div className="text-sm font-semibold">{s.title}</div>
                <div className="text-xs text-muted mt-0.5">{s.sub}</div>
              </div>
              <span
                className={`shrink-0 text-[11px] font-semibold px-2 py-0.5 rounded-full tabular-nums whitespace-nowrap ${
                  i === 0 ? "bg-accent-soft text-accent" : "bg-inset text-muted"
                }`}
              >
                {untilText(s.at, now)}
              </span>
            </li>
          );
        })}
      </ol>
    </Card>
  );
};

/** A group's slots as small squares, filled for each one in use. */
export const SlotSquares: React.FC<{ used: number; slots: number; tone?: string }> = ({ used, slots, tone = "bg-accent" }) => (
  <span className="flex gap-[3px]" aria-hidden="true">
    {Array.from({ length: Math.min(slots, 10) }, (_, i) => (
      <span
        key={i}
        data-testid="slot"
        data-used={i < used}
        className={`w-2.5 h-2.5 rounded-[3px] box-border ${i < used ? `${tone} nx-slot-pop` : "border-[1.5px] border-line"}`}
      />
    ))}
  </span>
);

/**
 * Strategy tabs over the open trades: All and each group, a pill sliding to
 * the one picked.
 */
export const StrategyTabs: React.FC<{
  groups: Pick<FloorGroup, "id" | "short">[];
  value: FloorGroupId | "all";
  onChange: (v: FloorGroupId | "all") => void;
}> = ({ groups, value, onChange }) => {
  const tabs: { id: FloorGroupId | "all"; short: string }[] = [{ id: "all", short: "All" }, ...groups];
  const at = Math.max(0, tabs.findIndex((t) => t.id === value));
  return (
    <div role="tablist" aria-label="Strategy" className="relative grid p-1 rounded-[14px] bg-inset" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
      <span
        aria-hidden="true"
        data-testid="strategy-pill"
        className="absolute top-1 bottom-1 left-1 rounded-[10px] bg-surface shadow-sm nx-strategy-pill"
        style={{ width: `calc((100% - 8px) / ${tabs.length})`, transform: `translateX(${at * 100}%)` }}
      />
      {tabs.map((t, i) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={i === at}
          onClick={() => onChange(t.id)}
          className={`relative min-h-9 px-0 text-xs font-semibold tracking-tight truncate cursor-pointer transition-colors ${i === at ? "text-ink" : "text-muted"}`}
        >
          {t.short}
        </button>
      ))}
    </div>
  );
};

const RING_R = 42;
const RING_C = 2 * Math.PI * RING_R;

/**
 * Paper money as a ring split by strategy: each group's share of the money in
 * its colour, the free cash in the rest. The segments sweep round when shown
 * and glide as trades open and close. Its legend picks a group to show.
 */
export const MoneyByStrategy: React.FC<{
  money: number;
  positions: Position[];
  groups: FloorGroup[];
  filter: FloorGroupId | "all";
  onPick: (id: FloorGroupId | "all") => void;
}> = ({ money, positions, groups, filter, onPick }) => {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(true), 60);
    return () => clearTimeout(t);
  }, []);
  const inTrades = moneyInTrades(positions);
  const free = freeCash(money, positions);
  const total = Math.max(1, inTrades + free);
  const share = money > 0 ? Math.max(0, Math.min(100, (inTrades / money) * 100)) : 0;
  const open = positions.filter((p) => !p.isLiveOrder).length;
  const held = groups.filter((g) => g.inTrades > 0);
  let at = 0;
  const segs = held.map((g) => {
    const full = (g.inTrades / total) * RING_C;
    const seg = { id: g.id, color: g.color, opacity: g.opacity, len: shown ? Math.max(0, full - 2) : 0, off: shown ? -at : 0 };
    at += full;
    return seg;
  });
  return (
    <Card aria-label="Paper money" className="flex items-center gap-4">
      <div data-testid="money-ring" className="relative shrink-0 w-[104px] h-[104px]">
        <svg viewBox="0 0 104 104" className="block w-full h-full -rotate-90" aria-hidden="true">
          <circle cx="52" cy="52" r={RING_R} fill="none" strokeWidth="11" style={{ stroke: "var(--color-accent-soft)" }} />
          {segs.map((s) => (
            <circle
              key={s.id}
              data-testid="ring-seg"
              cx="52"
              cy="52"
              r={RING_R}
              fill="none"
              strokeWidth="11"
              className="nx-ring-seg"
              style={{
                stroke: s.color,
                opacity: filter === "all" || filter === s.id ? s.opacity : s.opacity * 0.25,
                strokeDasharray: `${s.len.toFixed(2)} ${RING_C.toFixed(2)}`,
                strokeDashoffset: s.off.toFixed(2),
              }}
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-display text-xl leading-none tabular-nums">{Math.round(share)}%</span>
          <span className="text-[10px] text-muted mt-0.5">in trades</span>
        </div>
      </div>
      <div className="flex flex-col gap-1.5 min-w-0 flex-1">
        <div data-testid="free-cash">
          <div className="text-xs text-muted flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-[3px] bg-accent-soft ring-1 ring-accent" />
            Free cash
          </div>
          <div className="font-display text-xl tabular-nums">
            <Rolling value={free} format={(n) => formatMoney(n)} />
          </div>
        </div>
        <div data-testid="in-trades" className="flex items-baseline justify-between gap-2 text-xs">
          <span className="text-muted">{open === 0 ? "Nothing in trades" : `In ${open} ${open === 1 ? "trade" : "trades"}`}</span>
          <span className="font-semibold tabular-nums">
            <Rolling value={inTrades} format={(n) => formatMoney(n, { decimals: 0 })} />
          </span>
        </div>
        {held.length > 1 && (
          <div className="flex flex-col">
            {held.map((g) => {
              const on = filter === g.id;
              return (
                <button
                  key={g.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onPick(on ? "all" : g.id)}
                  className={`flex items-center gap-2 min-h-7 -mx-1.5 px-1.5 rounded-lg text-xs text-left cursor-pointer transition-[background-color,opacity] ${
                    on ? "bg-inset" : ""
                  } ${filter === "all" || on ? "" : "opacity-55"}`}
                >
                  <span className="w-2 h-2 rounded-[3px] shrink-0" style={{ background: g.color, opacity: g.opacity }} />
                  <span className="flex-1 min-w-0 truncate">{g.label}</span>
                  <span className="tabular-nums text-muted">{formatMoney(g.inTrades, { decimals: 0 })}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
};

/** What an empty group is waiting for, in words. */
export function emptyGroupText(id: FloorGroupId, now: number): string {
  const day = deskDay(now).events;
  const when = (ev: DeskEventId) => {
    const at = day.find((e) => e.id === ev)?.nextAt;
    if (!at) return "";
    const c = istClock(at);
    return `${c.day} ${c.time} ${c.half}`;
  };
  switch (id) {
    case "coin-breakout":
      return `No coin trade. It buys one that closes above its 55-day high; next check ${when("coin-check")}.`;
    case "us-breakout":
      return `No trade. It buys a stock above its 55-day high at the 3:45 pm New York check; next ${when("us-checks")}.`;
    case "funds":
      return `No trade. It buys a fund above its 55-day high at the 3:45 pm New York check; next ${when("us-checks")}.`;
    case "us-momentum":
      return "No trade. It holds the 3 biggest risers, picked at the week's last US check, while SPY is above its 200-day average.";
    default:
      return "No trade open.";
  }
}

