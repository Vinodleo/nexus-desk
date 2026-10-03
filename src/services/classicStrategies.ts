import { quarterOf, type CandleSeries } from "./historyReplay";
import type { TraderRecord } from "./exitExpectancy";

// Step 2 of trading slower: strategies with long public records, tested on
// the same daily coin candles since 2017 as the traders (history/dailyLong.ts),
// on the same coins each year, after the same fees and spreads.
//
// - Breakout 55/20 (the "Turtle" rules trend-following funds made famous):
//   buy a close above the last 55 days' high; sell a close below the last 20
//   days' low, or at a stop 2 ATR below the entry.
// - Moving averages 50/200: hold a coin while its 50-day average is above
//   its 200-day and Bitcoin is above its own 200-day (a guard against
//   falling markets); a stop 3 ATR below the entry.
// - Momentum, top 3: each Monday, hold the 3 coins on the year's list that
//   rose most over 90 days (if they rose at all), only while Bitcoin is above
//   its 200-day average; a stop 3 ATR below the entry.
//
// Long only, entered and exited at the day's close (a stop at the stop, or
// the open when it gaps through), one position per coin per strategy. A
// result is in R: the gain after costs over the distance to the first stop,
// as the traders' are. A trade still open when a coin's candles end is
// judged at its last close (a delisted coin's last price included).

export type ClassicId = "breakout" | "maTrend" | "momentum";
export const CLASSIC_IDS: ClassicId[] = ["breakout", "maTrend", "momentum"];

export const CLASSIC_STRATEGIES: Record<ClassicId, { name: string; rule: string }> = {
  breakout: {
    name: "Breakout 55/20",
    rule: "Buys a close above the last 55 days' high; sells a close below the last 20 days' low, or 2 ATR below the entry.",
  },
  maTrend: {
    name: "Moving averages 50/200",
    rule: "Holds a coin while its 50-day average is above its 200-day and Bitcoin is above its own 200-day; or until 3 ATR below the entry.",
  },
  momentum: {
    name: "Momentum, top 3",
    rule: "Each Monday holds the 3 coins that rose most over 90 days (if they rose), while Bitcoin is above its 200-day average; or until 3 ATR below the entry.",
  },
};

export interface ClassicTrade {
  strategy: ClassicId;
  symbol: string;
  /** The close it was entered at and left at (ms). */
  entryMs: number;
  exitMs: number;
  r: number;
  /** Still open when the candles ended: judged at the last close. */
  open?: boolean;
}

/** Results by quarter ("2022-Q2"), then strategy. */
export type ClassicRecords = Record<string, Partial<Record<ClassicId, TraderRecord>>>;

const DAY_MS = 24 * 60 * 60 * 1000;
export const ATR_DAYS = 20;
const BREAKOUT_ENTRY_DAYS = 55;
const BREAKOUT_EXIT_DAYS = 20;
const BREAKOUT_STOP_ATR = 2;
const FAST_DAYS = 50;
const SLOW_DAYS = 200;
const TREND_STOP_ATR = 3;
const MOMENTUM_DAYS = 90;
export const MOMENTUM_HOLD = 3;

/** Simple moving average of `xs` over `n` values, per index (undefined until there are `n`). */
export function sma(xs: number[], n: number): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(xs.length).fill(undefined);
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    sum += xs[i];
    if (i >= n) sum -= xs[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** Average true range over `n` days, per index (undefined until there are `n` + 1 candles). */
export function atr(s: CandleSeries, n: number = ATR_DAYS): (number | undefined)[] {
  const tr = s.c.map((_, i) => (i === 0 ? s.h[0] - s.l[0] : Math.max(s.h[i] - s.l[i], Math.abs(s.h[i] - s.c[i - 1]), Math.abs(s.l[i] - s.c[i - 1]))));
  const avg = sma(tr, n);
  return avg.map((x, i) => (i >= n ? x : undefined));
}

/** A trade's result in R: its gain after round-trip costs (share of entry) over the distance to its first stop. */
export function resultR(entry: number, exit: number, risk: number, cost: number): number {
  return ((exit - entry) / entry - cost) / (risk / entry);
}

/** Where a stop fills on a day that reaches it: at the stop, or the open when the day gaps below it. */
const stopFill = (s: CandleSeries, j: number, stop: number) => Math.min(s.o[j], stop);

/** The day a candle closes, for whether a coin was on that year's list. */
const closeMs = (s: CandleSeries, i: number) => s.t[i] + DAY_MS;

/** An open position, and how to close it into a trade. */
interface Held {
  i: number;
  entry: number;
  stop: number;
  risk: number;
}

function close(strategy: ClassicId, symbol: string, s: CandleSeries, h: Held, j: number, exit: number, cost: number, open?: boolean): ClassicTrade {
  return { strategy, symbol, entryMs: closeMs(s, h.i), exitMs: closeMs(s, j), r: resultR(h.entry, exit, h.risk, cost), ...(open ? { open } : {}) };
}

/**
 * Whether the close of day `i` breaks out (above the last 55 days' high),
 * with its entry and risk (2 ATR); null otherwise. The replay and the paper
 * trades (server/scanner/dailyCoins.ts) both enter by it.
 */
export function breakoutEntryAt(s: CandleSeries, i: number, range: (number | undefined)[] = atr(s)): { entry: number; risk: number; atr: number } | null {
  const a = range[i];
  if (i < BREAKOUT_ENTRY_DAYS || a === undefined || !(a > 0)) return null;
  if (!(s.c[i] > Math.max(...s.h.slice(i - BREAKOUT_ENTRY_DAYS, i)))) return null;
  return { entry: s.c[i], risk: BREAKOUT_STOP_ATR * a, atr: a };
}

/** Whether the close of day `i` is below the last 20 days' low: a breakout trade is sold there. */
export function breakoutExitAt(s: CandleSeries, i: number): boolean {
  return i >= BREAKOUT_EXIT_DAYS && s.c[i] < Math.min(...s.l.slice(i - BREAKOUT_EXIT_DAYS, i));
}

/**
 * Breakout 55/20 on one coin's daily candles. `eligible` says whether a
 * trade may open at a close (the coin on that year's list); `cost` is a
 * round trip's fees and spread (share of price).
 */
export function breakoutTrades(symbol: string, s: CandleSeries, cost: number, eligible: (ms: number) => boolean): ClassicTrade[] {
  const n = s.t.length;
  const range = atr(s);
  const trades: ClassicTrade[] = [];
  let held: Held | null = null;
  for (let i = BREAKOUT_ENTRY_DAYS; i < n; i++) {
    if (held) {
      if (s.l[i] <= held.stop) {
        trades.push(close("breakout", symbol, s, held, i, stopFill(s, i, held.stop), cost));
        held = null;
      } else if (breakoutExitAt(s, i)) {
        trades.push(close("breakout", symbol, s, held, i, s.c[i], cost));
        held = null;
      }
      continue;
    }
    if (!eligible(closeMs(s, i))) continue;
    const entry = breakoutEntryAt(s, i, range);
    if (entry) held = { i, entry: entry.entry, stop: entry.entry - entry.risk, risk: entry.risk };
  }
  if (held) trades.push(close("breakout", symbol, s, held, n - 1, s.c[n - 1], cost, true));
  return trades;
}

/**
 * A market above its 200-day average at a day's close, by the day's start
 * (ms); undefined before it has one. Bitcoin for coins; for stocks the
 * market's index fund (SPY, the Nifty ETF), whose candles start when the
 * stocks' do.
 */
export function uptrend(market: CandleSeries): (dayStartMs: number) => boolean | undefined {
  const avg = sma(market.c, SLOW_DAYS);
  const byDay = new Map<number, boolean>();
  market.t.forEach((t, i) => {
    if (avg[i] !== undefined) byDay.set(t, market.c[i] > avg[i]!);
  });
  return (dayStartMs) => byDay.get(dayStartMs);
}
/** Bitcoin above its 200-day average at a day's close (coins' guard). */
export const btcUptrend = uptrend;

/** Coins rebalance at the weekly close: the candle that ends at the start of Monday (UTC). */
export const coinWeekClose = (day: number) => new Date(day + DAY_MS).getUTCDay() === 1;

/**
 * Stocks rebalance at the week's last session: the candle whose next one is
 * in another week. A stock's daily candle starts at local midnight (New York's
 * 04:00 or 05:00 UTC, India's 18:30 UTC the day before), so its date is read
 * half a day on; weeks start on Monday.
 */
export function stockWeekClose(day: number, next: number | undefined): boolean {
  const week = (ms: number) => Math.floor((Math.floor((ms + DAY_MS / 2) / DAY_MS) + 3) / 7);
  return next !== undefined && week(next) !== week(day);
}

/**
 * Moving averages 50/200 on one coin: enters when "50-day above 200-day,
 * and Bitcoin above its 200-day" turns true at a close; leaves when it turns
 * false, or at the stop. After a stop, it waits for the next turn.
 */
export function maTrendTrades(
  symbol: string,
  s: CandleSeries,
  btcUp: (dayStartMs: number) => boolean | undefined,
  cost: number,
  eligible: (ms: number) => boolean
): ClassicTrade[] {
  const n = s.t.length;
  const fast = sma(s.c, FAST_DAYS);
  const slow = sma(s.c, SLOW_DAYS);
  const range = atr(s);
  const trades: ClassicTrade[] = [];
  const inTrend = (i: number) => fast[i] !== undefined && slow[i] !== undefined && fast[i]! > slow[i]! && btcUp(s.t[i]) === true;
  let held: Held | null = null;
  for (let i = SLOW_DAYS; i < n; i++) {
    const now = inTrend(i);
    if (held) {
      if (s.l[i] <= held.stop) {
        trades.push(close("maTrend", symbol, s, held, i, stopFill(s, i, held.stop), cost));
        held = null;
      } else if (!now) {
        trades.push(close("maTrend", symbol, s, held, i, s.c[i], cost));
        held = null;
      }
      continue;
    }
    const a = range[i];
    if (now && !inTrend(i - 1) && a !== undefined && a > 0 && eligible(closeMs(s, i))) {
      const risk = TREND_STOP_ATR * a;
      held = { i, entry: s.c[i], stop: s.c[i] - risk, risk };
    }
  }
  if (held) trades.push(close("maTrend", symbol, s, held, n - 1, s.c[n - 1], cost, true));
  return trades;
}

/**
 * Momentum, top 3, across coins (or stocks): each week's close, the ones on that
 * year's list (`eligible`) that rose most over 90 days, if they rose and the
 * market (Bitcoin, or the stocks' index fund) is above its 200-day average.
 * Those leaving the top are sold at that close; between weeks one can stop out.
 */
export function momentumTrades(
  coins: Record<string, CandleSeries>,
  btcUp: (dayStartMs: number) => boolean | undefined,
  costFor: (symbol: string) => number,
  eligible: (symbol: string, ms: number) => boolean,
  /** Whether a candle (by its start, and the next one's) is the week's close: coins' Sunday by default. */
  weekClose: (day: number, next: number | undefined) => boolean = coinWeekClose
): ClassicTrade[] {
  const symbols = Object.keys(coins);
  const index = new Map(symbols.map((sym) => [sym, new Map(coins[sym].t.map((t, i) => [t, i]))]));
  const ranges = new Map(symbols.map((sym) => [sym, atr(coins[sym])]));
  const days = [...new Set(symbols.flatMap((sym) => coins[sym].t))].sort((a, b) => a - b);
  const held = new Map<string, Held>();
  const trades: ClassicTrade[] = [];
  const sell = (sym: string, i: number, exit: number, open?: boolean) => {
    trades.push(close("momentum", sym, coins[sym], held.get(sym)!, i, exit, costFor(sym), open));
    held.delete(sym);
  };
  for (const [k, day] of days.entries()) {
    // Stops first, on every held coin's candle that day.
    for (const [sym, h] of [...held]) {
      const i = index.get(sym)!.get(day);
      if (i !== undefined && coins[sym].l[i] <= h.stop) sell(sym, i, stopFill(coins[sym], i, h.stop));
    }
    // Rebalanced at the week's close.
    if (!weekClose(day, days[k + 1])) continue;
    const up = btcUp(day) === true;
    const ranked = up
      ? symbols
          .flatMap((sym) => {
            const i = index.get(sym)!.get(day);
            const s = coins[sym];
            if (i === undefined || i < MOMENTUM_DAYS || !eligible(sym, closeMs(s, i))) return [];
            const rise = s.c[i] / s.c[i - MOMENTUM_DAYS] - 1;
            return rise > 0 ? [{ sym, rise }] : [];
          })
          .sort((a, b) => b.rise - a.rise)
          .slice(0, MOMENTUM_HOLD)
          .map((x) => x.sym)
      : [];
    for (const sym of [...held.keys()]) {
      if (ranked.includes(sym)) continue;
      // Not trading that day (delisted): sold at its last close.
      const i = index.get(sym)!.get(day) ?? coins[sym].t.length - 1;
      sell(sym, i, coins[sym].c[i]);
    }
    for (const sym of ranked) {
      if (held.has(sym)) continue;
      const i = index.get(sym)!.get(day)!;
      const a = ranges.get(sym)![i];
      if (a === undefined || !(a > 0)) continue;
      const s = coins[sym];
      const risk = TREND_STOP_ATR * a;
      held.set(sym, { i, entry: s.c[i], stop: s.c[i] - risk, risk });
    }
  }
  for (const sym of [...held.keys()]) sell(sym, coins[sym].t.length - 1, coins[sym].c[coins[sym].t.length - 1], true);
  return trades;
}

/** Adds trades to the records, by the quarter they opened in. */
export function addClassicTrades(records: ClassicRecords, trades: ClassicTrade[]): void {
  for (const t of trades) {
    const byStrategy = (records[quarterOf(t.entryMs)] ??= {});
    const rec = (byStrategy[t.strategy] ??= { trades: 0, totalR: 0, wins: 0, winR: 0, lossR: 0 });
    rec.trades++;
    rec.totalR += t.r;
    if (t.r > 0) {
      rec.wins++;
      rec.winR += t.r;
    } else rec.lossR += t.r;
  }
}
