import React, { useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import type { HistoricalTrade } from "../../types";
import { TradeAutopsyCard } from "../TradeAutopsyCard";
import { Segmented } from "./ui";
import { formatMoney, formatPct, formatPrice, pnlTone, stopSlip } from "./format";
import { LedgerBreakdown, tradeExcursion } from "./LedgerBreakdown";
import { RollingDigits, staggerDelay, usePresence, useSlideFrom } from "./motion";
import { DayCalendar, MonthLine, localDay, monthName, monthOf, weekdayDay } from "./BookCalendar";
import { exitWords, strategyBadge, strategyOf } from "./BookMoney";

export type BookFilter = "all" | "wins" | "losses";

export { stopSlip };


/** Totals for the summary card. Wins and losses are by net P&L after fees. */
export function summarizeTrades(trades: HistoricalTrade[]) {
  let won = 0;
  let lost = 0;
  let fees = 0;
  let wins = 0;
  for (const t of trades) {
    if (t.realizedPnl > 0) {
      won += t.realizedPnl;
      wins++;
    } else {
      lost += -t.realizedPnl;
    }
    fees += t.feesPaid || 0;
  }
  return {
    count: trades.length,
    wins,
    net: won - lost,
    won,
    lost,
    fees,
    winPct: trades.length > 0 ? Math.round((wins / trades.length) * 100) : null,
  };
}

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "Today", "Yesterday" or "Wed 23 Sep"; trades without a timestamp go under "Earlier". */
export function dayLabel(ms: number | undefined, now = Date.now()): string {
  if (!ms) return "Earlier";
  if (dayKey(ms) === dayKey(now)) return "Today";
  if (dayKey(ms) === dayKey(now - 86400000)) return "Yesterday";
  return weekdayDay(ms);
}

/** Stops this close together, in one market, count as one market dip. */
export const LINKED_STOP_GAP_MS = 5 * 60 * 1000;
/** A dip needs at least this many stops. */
export const LINKED_STOP_MIN = 3;

const marketKind = (symbol: string) => (/\.US$/.test(symbol) ? "us" : symbol.includes("/") ? "coins" : "stocks");
const isStopLoss = (t: HistoricalTrade) => t.realizedPnl < 0 && /STOP/.test(t.exitReason);

export type BookItem = { kind: "trade"; trade: HistoricalTrade } | { kind: "dip"; trades: HistoricalTrade[] };

/**
 * Trades newest first, with runs of losing stops that hit within a few
 * minutes of each other in one market gathered into one "market dip": the
 * market fell and took them together, which is one event, not several
 * separate mistakes.
 */
export function groupLinkedStops(trades: HistoricalTrade[]): BookItem[] {
  const out: BookItem[] = [];
  let run: HistoricalTrade[] = [];
  const flush = () => {
    if (run.length >= LINKED_STOP_MIN) out.push({ kind: "dip", trades: run });
    else run.forEach((t) => out.push({ kind: "trade", trade: t }));
    run = [];
  };
  for (const t of trades) {
    const last = run[run.length - 1];
    const linked =
      last &&
      isStopLoss(t) &&
      t.closedAtMs !== undefined &&
      last.closedAtMs !== undefined &&
      Math.abs(last.closedAtMs - t.closedAtMs) <= LINKED_STOP_GAP_MS &&
      marketKind(t.symbol) === marketKind(last.symbol);
    if (!linked) flush();
    if (isStopLoss(t) && t.closedAtMs !== undefined) run.push(t);
    else out.push({ kind: "trade", trade: t });
  }
  flush();
  return out;
}

function heldFor(t: HistoricalTrade): string {
  let mins = t.holdingDurationMinutes;
  if (typeof mins !== "number" && t.openedAtMs && t.closedAtMs) mins = Math.round((t.closedAtMs - t.openedAtMs) / 60000);
  if (typeof mins !== "number" || mins < 0) return "—";
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return h < 48 ? `${h} h ${mins % 60} min` : `${Math.round(h / 24)} days`;
}

function timeOf(t: HistoricalTrade): string {
  return t.closedAtMs
    ? new Date(t.closedAtMs).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false })
    : t.closedAt;
}

/**
 * Where a closed trade went while it was open, in R (what it risked): the
 * best it got to for you, the worst against you, and where it closed (before
 * fees), on a line wide enough to show the stop at −1R. Null without the
 * record (older trades).
 */
export function moveLine(t: HistoricalTrade): { lo: number; hi: number; bestR: number; worstR: number; exitR: number } | null {
  const x = tradeExcursion(t);
  if (!x) return null;
  const perUnit = t.riskAtOpen! / t.quantity;
  const exitR = (t.direction === "LONG" ? t.exitPrice - t.entryPrice : t.entryPrice - t.exitPrice) / perUnit;
  return { ...x, exitR, lo: Math.min(-1, -x.worstR, exitR), hi: Math.max(1, x.bestR, exitR) };
}

const signedR = (r: number) => `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(1)}R`;

/** The move line, drawn outward from the entry when the card opens; the close drops on last. */
const HowItMoved: React.FC<{ trade: HistoricalTrade }> = ({ trade: t }) => {
  const m = moveLine(t);
  if (!m) return null;
  const x = (r: number) => (r - m.lo) / (m.hi - m.lo);
  const pct = (f: number) => `${(f * 100).toFixed(2)}%`;
  return (
    <div className="flex flex-col gap-1.5" data-testid="how-it-moved">
      <div className="text-xs text-muted">How it moved</div>
      <div className="relative h-5" aria-hidden="true">
        <div className="absolute inset-x-0 top-2 h-1 rounded-full bg-line" />
        <div className="absolute top-2 h-1 rounded-l-full bg-loss/40 nx-grow-left" style={{ left: pct(x(-m.worstR)), width: pct(x(0) - x(-m.worstR)) }} />
        <div className="absolute top-2 h-1 rounded-r-full bg-gain/40 nx-grow" style={{ left: pct(x(0)), width: pct(x(m.bestR) - x(0)) }} />
        <div className="absolute top-[3px] w-0.5 h-3.5 -ml-px bg-loss" style={{ left: pct(x(-1)) }} />
        <div className="absolute top-[3px] w-0.5 h-3.5 -ml-px bg-muted" style={{ left: pct(x(0)) }} />
        <div
          data-testid="exit-dot"
          className={`absolute top-[3px] w-3.5 h-3.5 -ml-[7px] rounded-full border-2 border-surface nx-exit-pop ${t.realizedPnl > 0 ? "bg-gain" : "bg-loss"}`}
          style={{ left: pct(x(m.exitR)) }}
        />
      </div>
      <p className="m-0 text-xs leading-relaxed">
        Went {signedR(m.bestR)} your way at best and {signedR(-m.worstR)} against at worst; closed at {signedR(m.exitR)} before fees.
      </p>
    </div>
  );
};

/** The result in R after fees (what the trade made over what it risked); null without the risk recorded. */
export const resultR = (t: HistoricalTrade): number | null => ((t.riskAtOpen ?? 0) > 0 ? t.realizedPnl / t.riskAtOpen! : null);

const Fact: React.FC<{ label: string; children: React.ReactNode; className?: string; wide?: boolean }> = ({ label, children, className = "", wide }) => (
  <div className={wide ? "col-span-3" : ""}>
    <dt className="text-[11px] text-muted">{label}</dt>
    <dd className={`m-0 text-[13px] font-semibold ${className}`}>{children}</dd>
  </div>
);

const TradeRow: React.FC<{
  trade: HistoricalTrade;
  open: boolean;
  onToggle: () => void;
  onUpdateTrade?: (t: HistoricalTrade) => void;
  /** Place in the list as it shows, for the stagger. */
  index?: number;
  /** The first row of its card has no rule above it. */
  first?: boolean;
}> = ({ trade: t, open, onToggle, onUpdateTrade, index = 0, first = false }) => {
  const won = t.realizedPnl > 0;
  const tone = pnlTone(t.realizedPnl);
  const r = resultR(t);
  const fees = t.feesPaid || 0;
  const trader = t.setupName || strategyOf(t);
  const who = t.strategy ? strategyOf(t) : t.timeframe === "1d" ? `${trader} · daily` : trader;
  // Opening tints the row and grows its details open; closing folds them away first.
  const details = usePresence(open, 260);
  return (
    <li className={`nx-row-in nx-trade${first ? "" : " border-t border-line"}${open ? " nx-trade-open" : ""}`} style={{ animationDelay: staggerDelay(index) }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2.5 px-3.5 py-3 text-left cursor-pointer"
      >
        <span className="min-w-0 flex items-center gap-2.5">
          <span
            aria-hidden="true"
            data-testid="row-badge"
            className={`w-[34px] h-[34px] shrink-0 rounded-[11px] grid place-items-center text-[11px] font-bold ${won ? "bg-gain/15 text-gain" : "bg-loss/15 text-loss"}`}
          >
            {strategyBadge(t)}
          </span>
          <span className="min-w-0 flex flex-col gap-px">
            <span className="text-[15px] font-bold truncate">{t.symbol}</span>
            <span className="text-xs text-muted leading-snug tabular-nums">
              {timeOf(t)} · {who} · {exitWords(t)}
              {t.isSelfApproved ? (t.openedByServer ? " · autopilot (server)" : " · autopilot") : ""}
            </span>
            {!open && t.autopsy && <span className="text-xs font-semibold text-accent">Read autopsy</span>}
          </span>
        </span>
        <span className="shrink-0 flex flex-col items-end gap-1">
          <span className={`font-display text-lg tabular-nums whitespace-nowrap ${tone}`}>{formatMoney(t.realizedPnl, { signed: true })}</span>
          <span className="flex items-center gap-1.5">
            {r !== null && (
              <span
                data-testid="row-r"
                className={`text-[11px] font-bold px-[7px] py-px rounded-full tabular-nums ${r > 0 ? "bg-gain/15 text-gain" : r < 0 ? "bg-loss/15 text-loss" : "bg-inset text-muted"}`}
              >
                {`${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(2)}R`}
              </span>
            )}
            <ChevronDown className={`w-3.5 h-3.5 text-muted nx-chevron${open ? " nx-chevron-open" : ""}`} />
          </span>
        </span>
      </button>
      {details.mounted && (
        <div data-testid="trade-details" className={`nx-trade-body ${details.leaving ? "nx-trade-body-out" : "nx-trade-body-in"}`}>
          <div>
            <div className="mx-3.5 mb-3.5 p-3 rounded-[14px] bg-inset flex flex-col gap-3">
              <HowItMoved trade={t} />
              <dl className="m-0 grid grid-cols-3 gap-x-2 gap-y-2.5 tabular-nums">
                <Fact label="Bought at">{formatPrice(t.direction === "LONG" ? t.entryPrice : t.exitPrice)}</Fact>
                <Fact label="Sold at">{formatPrice(t.direction === "LONG" ? t.exitPrice : t.entryPrice)}</Fact>
                <Fact label="Held">{heldFor(t)}</Fact>
                <Fact label="Before fees">{formatMoney(t.realizedPnl + fees, { signed: true, decimals: 0 })}</Fact>
                <Fact label="Fees">{formatMoney(fees, { decimals: 0 })}</Fact>
                <Fact label="Kept" className={tone}>
                  {formatMoney(t.realizedPnl, { signed: true, decimals: 0 })}
                </Fact>
                <Fact label="Money placed">{formatMoney(t.moneyPlaced, { decimals: 0 })}</Fact>
                <Fact label="Return" className={tone}>
                  {formatPct(t.realizedPnlPercent)}
                </Fact>
                <Fact label={t.direction === "LONG" ? "Long" : "Short"}>{t.quantity}</Fact>
                <Fact label="Setup" wide>
                  {t.setupName}
                </Fact>
                {stopSlip(t) && (
                  <Fact label="Stop → sold at" wide>
                    {formatPrice(t.stopAtExit!)} → {formatPrice(t.fillAtExit!)}
                    {stopSlip(t)!.pct >= 0.05 && (
                      <span className="text-loss font-normal">
                        {" "}
                        · {stopSlip(t)!.pct.toFixed(2)}% past the stop: the price moved through it between checks
                      </span>
                    )}
                  </Fact>
                )}
              </dl>
              <TradeAutopsyCard trade={t} onUpdateTrade={onUpdateTrade} />
            </div>
          </div>
        </div>
      )}
    </li>
  );
};

const PAGE = 30;
const FILTERS = [
  { id: "all", label: "All" },
  { id: "wins", label: "Wins" },
  { id: "losses", label: "Losses" },
] as const;

/** The month a closed trade is filed under: its close's, or this month's for the few without one. */
const fileMonth = (t: HistoricalTrade, thisMonth: number) => (t.closedAtMs !== undefined ? monthOf(t.closedAtMs) : thisMonth);

export const LedgerBookTrades: React.FC<{
  trades: HistoricalTrade[];
  onUpdateTrade?: (t: HistoricalTrade) => void;
  now?: number;
}> = ({ trades, onUpdateTrade, now: fixedNow }) => {
  const now = fixedNow ?? Date.now();
  const thisMonth = monthOf(now);
  // Opens on this month; the arrows or a swipe on the days go back to any month, and forward to this one.
  const [month, setMonth] = useState(thisMonth);
  const [filter, setFilter] = useState<BookFilter>("all");
  // A day picked on the calendar: only its trades show.
  const [day, setDay] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const go = (m: number) => {
    const to = Math.min(thisMonth, m);
    if (to === month) return;
    setMonth(to);
    setDay(null);
    setShown(PAGE);
  };
  // The month's name slides in from the side it came from; its total rolls to the new figure.
  const slide = useRef({ month, cls: "" });
  if (slide.current.month !== month) slide.current = { month, cls: month > slide.current.month ? "nx-tab-from-right" : "nx-tab-from-left" };

  const inMonth = useMemo(() => trades.filter((t) => fileMonth(t, thisMonth) === month), [trades, month, thisMonth]);
  const summary = summarizeTrades(inMonth);
  // The latest earlier month with trades, offered when this one has none.
  const earlier = useMemo(
    () => trades.reduce<number | null>((best, t) => {
      const m = fileMonth(t, thisMonth);
      return m < month && (best === null || m > best) ? m : best;
    }, null),
    [trades, month, thisMonth]
  );

  const filtered = useMemo(() => {
    const list = inMonth
      .filter((t) => (filter === "wins" ? t.realizedPnl > 0 : filter === "losses" ? t.realizedPnl <= 0 : true))
      .filter((t) => !day || (t.closedAtMs !== undefined && localDay(t.closedAtMs) === day));
    // Newest first.
    return [...list].sort((a, b) => (b.closedAtMs ?? 0) - (a.closedAtMs ?? 0));
  }, [inMonth, filter, day]);

  const groups: { label: string; trades: HistoricalTrade[] }[] = [];
  for (const t of filtered.slice(0, shown)) {
    const label = dayLabel(t.closedAtMs, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.trades.push(t);
    else groups.push({ label, trades: [t] });
  }

  const totalText = formatMoney(summary.net, { signed: true, decimals: 0 });
  return (
    <div className="flex flex-col gap-4">
      <section aria-label="The month" className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            aria-label="Earlier month"
            onClick={() => go(month - 1)}
            className="w-11 h-11 shrink-0 rounded-full border border-line bg-surface grid place-items-center text-ink cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="min-w-0 flex flex-col items-center text-center">
            <div key={month} className={`text-[13px] text-muted ${slide.current.cls}`} data-testid="calendar-month">
              {monthName(month)}
            </div>
            <div
              data-testid="month-total"
              className={`font-display text-[40px] leading-[1.1] tabular-nums ${summary.count === 0 ? "text-muted" : pnlTone(summary.net)}`}
            >
              <RollingDigits text={totalText} />
            </div>
            <div className="text-xs text-muted tabular-nums" data-testid="month-sub">
              {summary.count === 0
                ? "No closed trades"
                : `${summary.count} ${summary.count === 1 ? "trade" : "trades"} · ${summary.wins} won · after fees`}
            </div>
          </div>
          <button
            type="button"
            aria-label="Later month"
            onClick={() => go(month + 1)}
            disabled={month >= thisMonth}
            className="w-11 h-11 shrink-0 rounded-full border border-line bg-surface grid place-items-center text-ink cursor-pointer disabled:text-line disabled:cursor-default"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        {month < thisMonth && (
          <button
            type="button"
            onClick={() => go(thisMonth)}
            className="self-center min-h-8 px-3 rounded-full border border-line text-xs font-semibold text-accent cursor-pointer nx-badge-pop"
          >
            Back to this month
          </button>
        )}
        <MonthLine key={month} trades={trades} month={month} now={now} />
      </section>

      {trades.length > 0 && (
        <DayCalendar
          trades={trades}
          month={month}
          picked={day}
          now={now}
          onSwipe={(dir) => go(month + dir)}
          onPick={(d) => {
            setDay(d);
            setShown(PAGE);
          }}
        />
      )}

      <div className="flex items-center gap-2.5">
        <Segmented
          label="Filter trades"
          className="flex-1"
          options={FILTERS}
          value={filter}
          onChange={(f) => {
            setFilter(f);
            setShown(PAGE);
          }}
        />
        {day && (
          <button
            type="button"
            aria-label="Show every day"
            onClick={() => setDay(null)}
            className="min-h-9 px-3 rounded-full border border-accent bg-accent-soft text-accent text-xs font-semibold cursor-pointer flex items-center gap-1.5 nx-badge-pop"
          >
            {new Date(`${day}T12:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
            <X className="w-3 h-3" strokeWidth={2.4} aria-hidden="true" />
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="py-6 flex flex-col items-center gap-3 text-sm text-muted text-center">
          <p className="m-0">
            {trades.length === 0
              ? "No closed trades yet. They'll appear here as positions close."
              : inMonth.length === 0
              ? `No closed trades in ${monthName(month)}.`
              : "No trades match this filter."}
          </p>
          {inMonth.length === 0 && earlier !== null && (
            <button
              type="button"
              onClick={() => go(earlier)}
              className="min-h-9 px-3.5 rounded-full border border-line bg-surface text-xs font-semibold text-accent cursor-pointer"
            >
              Go to {monthName(earlier)}
            </button>
          )}
        </div>
      ) : (
        <section key={`${month}-${filter}-${day}`} aria-label="Closed trades" className="flex flex-col gap-4">
          {groups.map((g, gi) => {
            const net = g.trades.reduce((a, t) => a + t.realizedPnl, 0);
            const items = groupLinkedStops(g.trades);
            return (
              <div key={g.label} className="flex flex-col gap-1.5 nx-step-in" style={{ animationDelay: `${Math.min(gi, 6) * 70}ms` }}>
                <div className="flex items-baseline justify-between px-1 text-xs">
                  <span className="font-semibold text-muted">{g.label}</span>
                  <span className={`font-semibold tabular-nums ${pnlTone(net)}`} data-testid="day-total">
                    {formatMoney(net, { signed: true, decimals: 0 })}
                  </span>
                </div>
                <ul className="list-none m-0 p-0 bg-surface border border-line rounded-[18px] overflow-hidden">
                  {items.map((item, i) =>
                    item.kind === "dip" ? (
                      <DipGroup
                        key={`dip-${item.trades[0].id}`}
                        first={i === 0}
                        trades={item.trades}
                        openId={openId}
                        onToggle={(id) => setOpenId(openId === id ? null : id)}
                        onUpdateTrade={onUpdateTrade}
                      />
                    ) : (
                      <TradeRow
                        key={item.trade.id}
                        first={i === 0}
                        index={filtered.indexOf(item.trade) % PAGE}
                        trade={item.trade}
                        open={openId === item.trade.id}
                        onToggle={() => setOpenId(openId === item.trade.id ? null : item.trade.id)}
                        onUpdateTrade={onUpdateTrade}
                      />
                    )
                  )}
                </ul>
              </div>
            );
          })}
          {filtered.length > shown && (
            <button
              type="button"
              onClick={() => setShown(shown + PAGE)}
              className="min-h-11 rounded-full border border-line bg-surface text-sm font-semibold cursor-pointer"
            >
              Show {Math.min(PAGE, filtered.length - shown)} more
            </button>
          )}
        </section>
      )}
    </div>
  );
};

/**
 * A market dip: several stops that hit together, folded into one card.
 * Tap to fan the trades out (they stagger in), tap again to fold them.
 */
const DipGroup: React.FC<{
  trades: HistoricalTrade[];
  openId: string | null;
  onToggle: (id: string) => void;
  onUpdateTrade?: (t: HistoricalTrade) => void;
  first?: boolean;
}> = ({ trades, openId, onToggle, onUpdateTrade, first: firstRow = false }) => {
  const [open, setOpen] = useState(false);
  const total = trades.reduce((a, t) => a + t.realizedPnl, 0);
  const times = trades.map((t) => t.closedAtMs as number);
  const first = Math.min(...times);
  const last = Math.max(...times);
  const mins = Math.max(1, Math.round((last - first) / 60000));
  const names = trades.map((t) => t.symbol.split("/")[0].replace(/\.US$/, "")).join(", ");
  const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return (
    <li className={`nx-row-in px-2 py-2${firstRow ? "" : " border-t border-line"}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="w-full p-3 rounded-xl bg-warn-soft text-warn-ink text-left cursor-pointer flex flex-col gap-1"
      >
        <span className="flex items-baseline justify-between gap-3">
          <strong className="text-sm">Market dip · {trades.length} stops</strong>
          <span className="font-display text-[19px] tabular-nums text-loss">{formatMoney(total, { signed: true })}</span>
        </span>
        <span className="text-xs">
          {names} within {mins} {mins === 1 ? "minute" : "minutes"} ({hhmm(first)}–{hhmm(last)}): the market fell and took them together.{" "}
          {open ? "Tap to fold." : "Tap to see each."}
        </span>
      </button>
      {open && (
        <ul className="list-none m-0 mt-1 p-0 ml-1.5 border-l-2 border-danger-line">
          {trades.map((t, i) => (
            <TradeRow key={t.id} index={i} first={i === 0} trade={t} open={openId === t.id} onToggle={() => onToggle(t.id)} onUpdateTrade={onUpdateTrade} />
          ))}
        </ul>
      )}
    </li>
  );
};

export interface LedgerBookProps {
  trades: HistoricalTrade[];
  onUpdateTrade?: (t: HistoricalTrade) => void;
  /** The Risk section, rendered when that tab is picked. */
  risk: React.ReactNode;
  /** Whether a limit or drill is blocking new trades; flags the Risk tab. */
  riskBlocked?: boolean;
  /** A live desk's Book says Live by its title, a paper one's Paper. */
  isLive?: boolean;
  /** The time it's shown at (tests); now by default. */
  now?: number;
}

type Section = "trades" | "breakdown" | "risk";
const SECTIONS: readonly Section[] = ["trades", "breakdown", "risk"];

export const LedgerBook: React.FC<LedgerBookProps> = ({ trades, onUpdateTrade, risk, riskBlocked, isLive = false, now }) => {
  const [section, setSection] = useState<Section>("trades");
  const slideClass = useSlideFrom(section, SECTIONS);
  return (
    <div className="font-ui text-ink flex flex-col gap-4 pb-4 select-none">
      <header className="pt-1 flex items-center justify-between gap-3 nx-fade-in">
        <h1 className="m-0 font-display text-[26px] font-semibold">Book</h1>
        <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${isLive ? "bg-warn-soft text-warn" : "bg-accent-soft text-accent"}`}>
          {isLive ? "Live" : "Paper"}
        </span>
      </header>
      <div className="relative flex p-1 rounded-full bg-surface border border-line" role="tablist" aria-label="Book sections">
        {/* The picked section's pill slides across. */}
        <span aria-hidden="true" className="absolute inset-y-1 left-1 w-[calc((100%_-_0.5rem)/3)] pointer-events-none">
          <span
            data-testid="book-section-pill"
            className="nx-segment-pill block h-full rounded-full bg-accent"
            style={{ transform: `translateX(${SECTIONS.indexOf(section) * 100}%)` }}
          />
        </span>
        {SECTIONS.map((s) => {
          const on = section === s;
          return (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setSection(s)}
              className={`relative flex-1 min-h-10 rounded-full text-sm font-semibold cursor-pointer flex items-center justify-center gap-1.5 transition-colors ${
                on ? "text-on-accent" : "text-muted"
              }`}
            >
              {s === "trades" ? "Trades" : s === "breakdown" ? "Breakdown" : "Risk"}
              {s === "risk" && riskBlocked && (
                <span className="w-2 h-2 rounded-full bg-loss" aria-label="blocked" />
              )}
            </button>
          );
        })}
      </div>
      <div key={section} className={slideClass}>
        {section === "trades" ? (
          <LedgerBookTrades trades={trades} onUpdateTrade={onUpdateTrade} now={now} />
        ) : section === "breakdown" ? (
          <LedgerBreakdown trades={trades} now={now} />
        ) : (
          risk
        )}
      </div>
    </div>
  );
};
