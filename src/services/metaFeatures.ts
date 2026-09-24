import type { MarketBar } from "../types";

// The inputs to the Lab-trained confidence model, computed one way for
// training (Lab replays, shadow-tracked setups) and for live scoring. They
// are read from 5-minute candles that already carry indicators
// (decorateBarsWithIndicators), at the candle the signal came from.
//
// Version 2: all six read from the candles (version 1 took ATR, RSI and VWAP
// from different formulas in the Lab and faked the slope from the regime
// label live). A model trained on another version isn't used.

export const META_FEATURE_VERSION = 2;
export const META_FEATURE_COUNT = 6;
/** Candles behind the slope input. */
const SLOPE_BARS = 20;
/** Candles behind the volume average, as the strategy builders use. */
const VOLUME_BARS = 10;

/**
 * [ATR as % of price, volume surge / 5 (capped at 1), RSI / 100, % from
 *  VWAP, UTC hour of the candle's close / 24, % change over the last 20
 *  candles], at bar `i` (default: the last). Price-based inputs are in
 * percent so all six sit roughly between -3 and 3 for the network.
 */
export function metaFeatures(bars: MarketBar[], i: number = bars.length - 1): number[] {
  const bar = bars[i];
  const price = bar.close;
  const atr = bar.atr ?? bar.high - bar.low;
  const recent = bars.slice(Math.max(0, i - VOLUME_BARS + 1), i + 1);
  const avgVolume = recent.reduce((a, b) => a + b.volume, 0) / VOLUME_BARS;
  const volumeSurge = avgVolume > 0 ? bar.volume / avgVolume : 0;
  const vwap = bar.vwap ?? price;
  const closeMs = (bar.timestampMs ?? Date.parse(bar.time)) + 5 * 60 * 1000;
  const hour = Number.isFinite(closeMs) ? new Date(closeMs).getUTCHours() : 0;
  const past = bars[Math.max(0, i - SLOPE_BARS)].close;
  return [
    price > 0 ? (atr / price) * 100 : 0,
    Math.min(volumeSurge / 5, 1),
    (bar.rsi ?? 50) / 100,
    vwap > 0 ? ((price - vwap) / vwap) * 100 : 0,
    hour / 24,
    past > 0 ? ((price - past) / past) * 100 : 0,
  ];
}
