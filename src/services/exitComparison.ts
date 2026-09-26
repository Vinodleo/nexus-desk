import type { MarketBar, StrategySetup } from "../types";
import { bankPartial, holdingDecision, partialDue, type ExitState } from "../shared/exitRules";
import { TRAIL_PROFILES, updateTrailingStop, type TrailProfileId, type TrailState } from "../shared/trailingStop";
import { atrForExits, holdMinutesFor, trailsAsRunner } from "../shared/coinHolds";
import { panelSetupsOnHistory, LAB_INTERVAL_MS } from "./labSimulation";
import { roundTripFeeRate } from "../shared/tradeCosts";

// Which trailing-stop profile makes the most money: every setup the live
// trader panel would have taken on history, played out candle by candle
// under each profile with the live exit rules (the same shared code the app
// and the server guardian run: bank half at +1R, trail, time limit).
//
// Candles hide the order of moves inside them, so this assumes the worst:
// a candle's dip is checked against the stop before its rise can help, and
// a gap through the stop fills at the candle's open.

/** Fees in and out, as a share of the entry price: CoinDCX's, or Angel One's for a ₹10,000 stock trade. */
const feeFor = (symbol: string) => roundTripFeeRate(symbol);

export interface ExitResult {
  /** Net result in multiples of the initial risk, after fees. */
  r: number;
  reason: "TAKE_PROFIT" | "STOP_LOSS" | "TRAILING_STOP" | "EXPIRY_TIME";
}

type SimPosition = TrailState & ExitState;

/**
 * Plays one setup, entered at the close of bar `i`, forward under a trail
 * profile. Null if the history ends within an hour of it.
 */
/**
 * @param spreadPct the market's bid-ask spread as a share of price: a round
 *   trip buys at the ask and sells at the bid, so it's paid once per trade.
 */
export function simulateExit(setup: StrategySetup, bars: MarketBar[], i: number, profile: TrailProfileId, spreadPct: number = 0): ExitResult | null {
  const entry = setup.entryPrice;
  const risk = Math.abs(entry - setup.stopLoss);
  if (!(risk > 0)) return null;
  const dir = setup.direction === "LONG" ? 1 : -1;
  const openMs = (bars[i].timestampMs as number) + LAB_INTERVAL_MS;
  const fee = feeFor(setup.symbol) + Math.max(0, spreadPct);
  const p: SimPosition = {
    symbol: setup.symbol,
    direction: setup.direction,
    entryPrice: entry,
    stopLoss: setup.stopLoss,
    takeProfit: setup.takeProfit,
    initialTakeProfit: setup.takeProfit,
    initialStopLoss: setup.stopLoss,
    quantity: 2,
    partialQuantity: 1,
    // Sized, trailed and timed exactly as a live position opened from this setup.
    atrAtEntry: atrForExits(setup, bars[i].atr),
    trailMode: trailsAsRunner(setup) ? "TREND_RUNNER" : "SCALP_TIGHT",
    family: setup.family,
    trailProfile: profile,
    expectedHoldingTimeMinutes: holdMinutesFor(setup),
    openTime: new Date(openMs).toISOString(),
    highestPrice: entry,
    lowestPrice: entry,
  };
  const crossedStop = (price: number) => (price - p.stopLoss) * dir <= 0;
  const reachedTarget = (price: number) => (price - p.takeProfit) * dir >= 0;

  const finish = (exit: number, reason: ExitResult["reason"]): ExitResult => {
    const banked = p.bankedQuantity ?? 0;
    const gainPerUnit =
      ((banked > 0 && p.bankedPrice !== undefined ? (p.bankedPrice - entry) * banked : 0) + (exit - entry) * (p.quantity - banked)) * dir / p.quantity;
    return { r: (gainPerUnit - entry * fee) / risk, reason };
  };
  const stopReason = (): ExitResult["reason"] => (p.trailActive || (p.stopLoss - entry) * dir >= 0 ? "TRAILING_STOP" : "STOP_LOSS");

  for (let j = i + 1; j < bars.length; j++) {
    const bar = bars[j];
    const adverse = dir > 0 ? bar.low : bar.high;
    const favourable = dir > 0 ? bar.high : bar.low;
    // 1. With the stop as it stood: a gap through the stop fills at the
    //    open; otherwise the dip is checked before the rise.
    if (crossedStop(bar.open)) return finish(bar.open, stopReason());
    if (crossedStop(adverse)) return finish(p.stopLoss, stopReason());
    // 2. The rise, in the order the live guardian handles a price: bank half
    //    at +1R, trail from the best price, then check the target. A runner
    //    reaching its first target doesn't close there: its stop locks at the
    //    target and the target moves out, as it does live.
    if (partialDue(p, favourable)) Object.assign(p, bankPartial(p, entry + dir * risk));
    updateTrailingStop(p, favourable);
    if (reachedTarget(favourable)) return finish(Math.max(p.takeProfit * dir, bar.open * dir) * dir, "TAKE_PROFIT");
    // A stop raised by the rise that the candle then fell back through.
    if (crossedStop(bar.close)) return finish(p.stopLoss, stopReason());
    // 3. The time limit, at the candle's close.
    const closeMs = (bar.timestampMs as number) + LAB_INTERVAL_MS;
    if (holdingDecision(p, closeMs) === "expire") return finish(bar.close, "EXPIRY_TIME");
  }
  // History ended with the trade still open. Coin trades run for hours, so
  // leaving these out would drop exactly the winners still running while
  // counting the losers that stopped out early: one that has run an hour is
  // judged at the last price; a younger one is left out (it would only show
  // the spread it paid).
  if (bars.length - 1 - i >= MARK_OPEN_AFTER_BARS) return finish(bars[bars.length - 1].close, "EXPIRY_TIME");
  return null;
}

/** An unfinished trade is judged at the last price once it has run this many 5-minute candles (an hour). */
export const MARK_OPEN_AFTER_BARS = 12;

export interface ProfileResult {
  profile: TrailProfileId;
  label: string;
  trades: number;
  winPct: number;
  /** Average result of winning and losing trades, in R after fees. */
  avgWinR: number;
  avgLossR: number;
  /** Average result per trade, in R: what a profile earns on each trade taken. */
  expectancyR: number;
  totalR: number;
}

/** Every profile over the same trades: the panel's setups on each coin's history. */
export function compareExitProfiles(sets: { symbol: string; bars: MarketBar[] }[], profiles: TrailProfileId[] = ["tight", "balanced", "patient", "fixed"]): ProfileResult[] {
  const trades = sets.flatMap((d) => panelSetupsOnHistory(d.symbol, d.bars).flatMap(({ i, setups }) => setups.map((setup) => ({ setup, bars: d.bars, i }))));
  return profiles.map((profile) => {
    const results = trades.map((t) => simulateExit(t.setup, t.bars, t.i, profile)).filter((r): r is ExitResult => r !== null);
    const wins = results.filter((r) => r.r > 0);
    const losses = results.filter((r) => r.r <= 0);
    const sum = (list: ExitResult[]) => list.reduce((a, r) => a + r.r, 0);
    const totalR = sum(results);
    return {
      profile,
      label: TRAIL_PROFILES[profile].label,
      trades: results.length,
      winPct: results.length > 0 ? Math.round((wins.length / results.length) * 100) : 0,
      avgWinR: wins.length > 0 ? sum(wins) / wins.length : 0,
      avgLossR: losses.length > 0 ? sum(losses) / losses.length : 0,
      expectancyR: results.length > 0 ? totalR / results.length : 0,
      totalR,
    };
  });
}

/**
 * Loads real 5-minute history for `symbols` (coins without it are skipped)
 * and compares the profiles on it.
 */
export async function runExitComparison(symbols: string[], bars: number = 3000): Promise<{ results: ProfileResult[]; coins: number }> {
  const { fetchRealHistoricalCandles } = await import("./realDataBacktestService");
  const { toLabBars } = await import("./labSimulation");
  const sets: { symbol: string; bars: MarketBar[] }[] = [];
  for (const symbol of symbols) {
    const candles = await fetchRealHistoricalCandles(symbol, "5m", bars, "BINANCE");
    if (candles.length < 200 || candles.some((c) => c.isSynthetic)) continue;
    sets.push({ symbol, bars: toLabBars(candles) });
  }
  if (sets.length === 0) throw new Error("Couldn't load real 5-minute history for any coin from Binance or Coinbase. Try again later.");
  return { results: compareExitProfiles(sets), coins: sets.length };
}
