import { isNseSymbol, nseRoundTripRate } from "./nse";
import { isUsSymbol, US_ROUND_TRIP_RATE } from "./usMarket";

// What a round trip costs next to how much it risks. A trade pays its fees
// and the bid-ask spread whether it wins or loses, so with a stop only a few
// times the costs away, the costs alone eat most of any win and push every
// loss well past 1R. (Indian stocks: about 0.27% in charges a round trip
// against 5-minute stops of 0.3–0.5%; that's most of a trader's edge gone.)
// Setups whose costs would take more than this share of the stop aren't
// taken, live or in the traders' replay.

/** Costs (fees + spread) may be at most this share of the distance to the stop. */
export const MAX_COST_SHARE_OF_STOP = 0.25;

/** CoinDCX's taker fee in and out (0.05% each way). */
export const COIN_ROUND_TRIP_FEE = 0.001;

/**
 * Fees for a round trip as a share of its value. Indian stocks at a
 * ₹10,000 trade: below ₹20,000 an order Angel One's brokerage is a flat 0.1%,
 * so the rate barely changes with the amount.
 */
export function roundTripFeeRate(symbol: string, notionalInr: number = 10_000): number {
  if (isUsSymbol(symbol)) return US_ROUND_TRIP_RATE;
  if (isNseSymbol(symbol)) return nseRoundTripRate(notionalInr);
  return COIN_ROUND_TRIP_FEE;
}

/** Fees plus the spread (both shares of price), as a share of the entry-to-stop distance. */
export function costShareOfStop(symbol: string, entry: number, stop: number, spreadPct: number = 0): number {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0) || !(entry > 0)) return Infinity;
  return ((roundTripFeeRate(symbol) + Math.max(0, spreadPct)) * entry) / risk;
}

export function costsTooBigForStop(symbol: string, entry: number, stop: number, spreadPct: number = 0): boolean {
  return costShareOfStop(symbol, entry, stop, spreadPct) > MAX_COST_SHARE_OF_STOP;
}
