import { isNseSymbol, nseRoundTripRate } from "./nse";
import { COIN_FEE_PER_SIDE } from "./tradeMath";
import { isUsSymbol, US_ROUND_TRIP_RATE } from "./usMarket";
import { marketOf } from "./marketLimits";

// What a round trip costs next to how much it risks. A trade pays its fees
// and the bid-ask spread whether it wins or loses, so with a stop only a few
// times the costs away, the costs alone eat most of any win and push every
// loss well past 1R. (Indian stocks: about 0.27% in charges a round trip
// against 5-minute stops of 0.3–0.5%; that's most of a trader's edge gone.)
// Setups whose costs would take more than this share of the stop aren't
// taken, live or in the traders' replay.

/** Costs (fees + spread) may be at most this share of the distance to the stop. */
export const MAX_COST_SHARE_OF_STOP = 0.25;

/** CoinDCX's fee and its GST in and out (0.59% each way, 1.18% a round trip; shared/tradeMath). */
export const COIN_ROUND_TRIP_FEE = Number((2 * COIN_FEE_PER_SIDE).toFixed(6));

/**
 * Fees for a round trip as a share of its value. Indian stocks at a
 * ₹10,000 trade: below ₹20,000 an order Angel One's brokerage is a flat 0.1%,
 * so the rate barely changes with the amount.
 */
export function roundTripFeeRate(symbol: string, notionalInr: number = 10_000): number {
  if (isUsSymbol(symbol)) return US_ROUND_TRIP_RATE;
  if (isNseSymbol(symbol)) return nseRoundTripRate(notionalInr);
  return coinRoundTrip;
}

let coinRoundTrip = COIN_ROUND_TRIP_FEE;
/**
 * Test hook: a cheaper coin round trip, for tests of the scanner's later
 * steps on 5-minute coin setups. CoinDCX's real fee stops every one of
 * those at the costs check (their stops are a few percent at most).
 */
export function _setCoinRoundTripFee(rate?: number): void {
  coinRoundTrip = rate ?? COIN_ROUND_TRIP_FEE;
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

// Coins with a wide spread aren't traded at all, however wide the stop.
// CoinDCX's INR spreads run 0.5–0.6% on many coins. A stop wide enough to
// pass the check above still hands a quarter of every trade's risk to costs,
// and those coins cost more than their spread says: it widens when prices
// move fast, and their thin books fill stops past the stop. At 0.2% a coin's
// costs (0.3% with fees) are at most a quarter of its smallest stop (1.2%).
// Live and in the traders' replay alike; swing trades, held for days, aren't
// held to it.

/** The widest bid-ask spread (share of price) a coin is traded at. */
export const MAX_COIN_SPREAD = 0.002;

/** Whether this coin's spread (share of price) is too wide to trade. Stocks aren't held to it. */
export function spreadTooWide(symbol: string, spreadPct: number): boolean {
  return marketOf(symbol) === "coins" && spreadPct > MAX_COIN_SPREAD;
}
