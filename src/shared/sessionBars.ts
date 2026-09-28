import type { MarketBar } from "../types";
import { isNseSymbol, istParts, NSE_CLOSE, NSE_OPEN } from "./nse";
import { isUsSymbol, nyParts, US_CLOSE, US_OPEN } from "./usMarket";

// Stock candles grouped by trading day, in the exchange's own time (New
// York for US stocks, IST for Indian ones), for traders that read the
// session itself: its opening candle, or yesterday's close. Coins trade
// around the clock and have no session.

export interface SessionClock {
  /** Minutes after midnight, exchange time, when the session opens and closes. */
  open: number;
  close: number;
  parts: (ms: number) => { day: string; minutes: number };
}

/** A stock's exchange clock; null for coins. */
export function sessionClock(symbol: string): SessionClock | null {
  if (isUsSymbol(symbol)) return { open: US_OPEN, close: US_CLOSE, parts: nyParts };
  if (isNseSymbol(symbol)) return { open: NSE_OPEN, close: NSE_CLOSE, parts: istParts };
  return null;
}

// A candle's exchange day and minute, worked out once: New York time comes
// from Intl, which is slow, and the traders' replay asks for the same
// candles many times over.
const timeCache = new WeakMap<MarketBar, { day: string; minutes: number }>();

/** When a candle opened, in its exchange's day and minutes after midnight. */
export function barTime(bar: MarketBar, clock: SessionClock): { day: string; minutes: number } {
  let t = timeCache.get(bar);
  if (!t) {
    const { day, minutes } = clock.parts(bar.timestampMs as number);
    t = { day, minutes };
    timeCache.set(bar, t);
  }
  return t;
}

export interface SessionDay {
  day: string;
  /** Oldest first. */
  bars: MarketBar[];
  /** Minutes after midnight, exchange time, that each candle opened. */
  minutes: number[];
}

/**
 * The last `days` trading days in `bars` (the latest candle's day last),
 * each with its candles oldest first. Candles without a time are skipped.
 */
export function recentSessions(clock: SessionClock, bars: MarketBar[], days: number): SessionDay[] {
  const out: SessionDay[] = [];
  for (let k = bars.length - 1; k >= 0; k--) {
    const bar = bars[k];
    if (bar.timestampMs === undefined) continue;
    const { day, minutes } = barTime(bar, clock);
    let current = out[out.length - 1];
    if (!current || current.day !== day) {
      if (out.length === days) break;
      current = { day, bars: [], minutes: [] };
      out.push(current);
    }
    current.bars.push(bar);
    current.minutes.push(minutes);
  }
  for (const d of out) {
    d.bars.reverse();
    d.minutes.reverse();
  }
  return out.reverse();
}
