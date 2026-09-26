import { marketOf } from "./marketLimits";

// Longer coin holds. CoinDCX's INR spreads run around 0.5–0.6%, paid on
// every trade (it buys at the ask and sells at the bid). Sized on 5-minute
// candles, a coin trade's stop was often 0.3–0.5% away, so the spread alone
// cost more than the whole risk, and most traders averaged below zero after
// costs. So coin trades are planned on the hourly scale instead:
//
// - stops and targets use an hourly-scale ATR (each trader's own multiples
//   of it), never closer than COIN_MIN_STOP_PCT;
// - the time limit is COIN_HOLD_MINUTES (a winner whose stop locks in profit
//   can run to 3× that, as before);
// - the trailing stop steps by the same hourly ATR, as a runner.
//
// Entries still come from the 5-minute signals.
//
// Indian stocks are planned the same way (still closed by 3:20 the same
// day). Angel One's intraday charges come to about 0.27% a round trip at
// ₹10,000, and 5-minute stops sat 0.3–0.5% away, so costs took 64–108% of
// the risk and every trader lost; the cost check then refused nearly every
// stock setup. On the hourly scale, with a 1.2% floor, costs are about a
// quarter of the stop. US stocks cost almost nothing to trade and stay on
// the 5-minute plan.

/** A coin trade's time limit: 4 hours. */
export const COIN_HOLD_MINUTES = 240;
/** The old limit, still used for stocks. */
export const INTRADAY_HOLD_MINUTES = 30;
/** Swing trades: 3 days. */
export const SWING_HOLD_MINUTES = 4320;
/** The least a coin trade's stop sits from entry: about twice the typical spread. */
export const COIN_MIN_STOP_PCT = 0.012;
/** An Indian stock trade's time limit: 3 hours (it's closed at 3:20 whatever). */
export const NSE_HOLD_MINUTES = 180;
/** The least an Indian stock trade's stop sits from entry: its costs (about 0.3%) are then a quarter of it. */
export const NSE_MIN_STOP_PCT = 0.012;
/** Hours of 5-minute candles the hourly ATR averages over. */
export const HOUR_ATR_HOURS = 6;
const CANDLES_PER_HOUR = 12;

/** Whether this is a coin. */
export const isCoin = (symbol: string | undefined): boolean => Boolean(symbol) && marketOf(symbol) === "coins";
/** Whether this is an Indian stock. */
const isNseStock = (symbol: string | undefined): boolean => Boolean(symbol) && marketOf(symbol!) === "stocks";
/** Coins and Indian stocks are planned on the hourly scale; US stocks aren't. */
export const plansHourly = (symbol: string | undefined): boolean => isCoin(symbol) || isNseStock(symbol);

/** How long a trade may run before the time limit applies. */
export function holdMinutesFor(setup: { symbol?: string; horizon?: "intraday" | "swing" }): number {
  if (setup.horizon === "swing") return SWING_HOLD_MINUTES;
  return isCoin(setup.symbol) ? COIN_HOLD_MINUTES : isNseStock(setup.symbol) ? NSE_HOLD_MINUTES : INTRADAY_HOLD_MINUTES;
}

/**
 * The ATR a trade is planned and trailed on: for coins and Indian stocks the
 * hourly one (or, without enough candles yet, the 5-minute one scaled to an
 * hour: volatility grows with the square root of time); for US stocks the
 * 5-minute one.
 */
export function planAtr(symbol: string | undefined, bar: { atr?: number; atrHour?: number; close: number }): number {
  const atr = bar.atr || bar.close * 0.005;
  if (!plansHourly(symbol)) return atr;
  return bar.atrHour && bar.atrHour > 0 ? bar.atrHour : atr * Math.sqrt(CANDLES_PER_HOUR);
}

/** The least distance to a stop, as a share of price: a trader's own floor, and at least COIN_MIN_STOP_PCT for coins, NSE_MIN_STOP_PCT for Indian stocks. */
export function stopFloorPct(symbol: string | undefined, traderFloor: number): number {
  if (isCoin(symbol)) return Math.max(traderFloor, COIN_MIN_STOP_PCT);
  if (isNseStock(symbol)) return Math.max(traderFloor, NSE_MIN_STOP_PCT);
  return traderFloor;
}

/**
 * Average true range of hour-long blocks of 5-minute candles, for each
 * candle: the last HOUR_ATR_HOURS blocks of 12 ending at it. Undefined until
 * there are enough candles, or when the candles aren't 5 minutes apart.
 */
export function hourlyAtrSeries(bars: { high: number; low: number; close: number; timestampMs?: number }[]): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(bars.length).fill(undefined);
  if (!fiveMinutesApart(bars)) return out;
  const need = HOUR_ATR_HOURS * CANDLES_PER_HOUR + 1;
  for (let i = need - 1; i < bars.length; i++) {
    let sum = 0;
    for (let h = 0; h < HOUR_ATR_HOURS; h++) {
      const end = i - h * CANDLES_PER_HOUR;
      const start = end - CANDLES_PER_HOUR + 1;
      let high = -Infinity;
      let low = Infinity;
      for (let k = start; k <= end; k++) {
        if (bars[k].high > high) high = bars[k].high;
        if (bars[k].low < low) low = bars[k].low;
      }
      const prevClose = bars[start - 1].close;
      sum += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    }
    out[i] = sum / HOUR_ATR_HOURS;
  }
  return out;
}

function fiveMinutesApart(bars: { timestampMs?: number }[]): boolean {
  const gaps: number[] = [];
  for (let i = Math.max(1, bars.length - 20); i < bars.length; i++) {
    const a = bars[i - 1].timestampMs;
    const b = bars[i].timestampMs;
    if (a !== undefined && b !== undefined) gaps.push(b - a);
  }
  if (gaps.length === 0) return false;
  gaps.sort((x, y) => x - y);
  const median = gaps[Math.floor(gaps.length / 2)];
  return Math.abs(median - 5 * 60 * 1000) <= 30 * 1000;
}

/**
 * Every coin trade aims to make at least this many times what it risks.
 * Scalpers' wins were too small for their losses (Priya: +0.54R wins
 * against −1.04R losses), so their targets were the first thing costs ate.
 */
export const COIN_MIN_TARGET_R = 2;
/** Range (reversion) trades: their VWAP target is often closer, so the same minimum applies. */
export const COIN_REVERSION_MIN_R = COIN_MIN_TARGET_R;

/** A target distance widened, for a coin or Indian stock, to at least COIN_MIN_TARGET_R times the stop. */
export function coinTargetDistance(symbol: string | undefined, targetDistance: number, stopDistance: number): number {
  return plansHourly(symbol) ? Math.max(targetDistance, stopDistance * COIN_MIN_TARGET_R) : targetDistance;
}

/**
 * The ATR a new position trails by: the one its setup was planned on (hourly
 * for coins), else the latest candle's; never under 0.3% of the price.
 */
export function atrForExits(setup: { planAtr?: number; entryPrice: number }, barAtr?: number): number {
  return Math.max(setup.planAtr ?? barAtr ?? 0, setup.entryPrice * 0.003);
}

/** Whether a position trails as a runner: trend, breakout and swing trades, and anything held over an hour (every coin trade). */
export function trailsAsRunner(setup: { family?: string; horizon?: string; symbol?: string }): boolean {
  return (
    setup.family === "trend_following" ||
    setup.family === "breakout_confirmation" ||
    setup.horizon === "swing" ||
    holdMinutesFor(setup as { symbol?: string; horizon?: "intraday" | "swing" }) > 60
  );
}
