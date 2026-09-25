// Best bid and ask for a market. CoinDCX's INR markets have wide spreads
// (Bitcoin's was 0.59%), and their trades land on either side, so the last
// trade price jumps between the two. A long position is bought at the ask
// and sold at the bid; judging its stop, trailing stop and target on trade
// prints lets a print at the ask ratchet the trailing stop up and a print at
// the bid knock it out. So positions are judged on the price they could
// actually be closed at: the bid for a long, the ask for a short.

export interface Quote {
  bid: number;
  ask: number;
  /** When it was read (ms). */
  at: number;
}

/** A quote older than this isn't used; positions fall back to trade prices. */
export const QUOTE_FRESH_MS = 15_000;

export function isFreshQuote(q: Quote | undefined, now: number = Date.now()): q is Quote {
  return !!q && q.bid > 0 && q.ask >= q.bid && now - q.at <= QUOTE_FRESH_MS;
}

/** The price a position can be closed at now: the bid for a long, the ask for a short. */
export function closeoutPrice(direction: "LONG" | "SHORT", q: Quote): number {
  return direction === "LONG" ? q.bid : q.ask;
}

/** The price a new position is opened at: the ask for a long, the bid for a short. */
export function entryPriceFrom(direction: "LONG" | "SHORT", q: Quote): number {
  return direction === "LONG" ? q.ask : q.bid;
}

/** Spread as a share of the mid price. */
export function spreadPct(q: Pick<Quote, "bid" | "ask">): number {
  const mid = (q.bid + q.ask) / 2;
  return mid > 0 ? (q.ask - q.bid) / mid : 0;
}
