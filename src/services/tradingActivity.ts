import type { MarketBar } from "../types";

// How often a coin actually trades. CoinDCX's 5-minute candles are built from
// 1-minute ones, and each records how many of its minutes had trades. A coin
// that goes minutes without a trade jumps when the next one comes: a stop
// set between two trades fills wherever the next trade happens, past the
// stop (as ZEC's did, 0.23% below it). Such coins aren't traded.

/** Candles looked back over: two hours. */
export const ACTIVITY_LOOKBACK_BARS = 24;
/** Least share of minutes with a trade for a coin to be traded. */
export const MIN_TRADING_ACTIVITY = 0.5;

/**
 * Share of minutes with at least one trade over the last two hours, or null
 * when the candles don't say (stocks, and candles from before this was recorded).
 */
export function tradingActivity(bars: MarketBar[] | null | undefined): number | null {
  const recent = (bars ?? []).slice(-ACTIVITY_LOOKBACK_BARS).filter((b) => typeof b.activeMinutes === "number");
  if (recent.length < ACTIVITY_LOOKBACK_BARS / 2) return null;
  return recent.reduce((a, b) => a + (b.activeMinutes as number), 0) / (recent.length * 5);
}

/** Whether the coin trades too rarely for its stops to fill near where they're set. */
export function tradesTooRarely(bars: MarketBar[] | null | undefined): boolean {
  const activity = tradingActivity(bars);
  return activity !== null && activity < MIN_TRADING_ACTIVITY;
}
