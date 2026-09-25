import { isFreshQuote, type Quote } from "../src/shared/quotes";

// The latest best bid and ask per market: coins from CoinDCX's order book
// (server/quotes.ts), stocks from Angel One's quotes (server/stockPrices.ts).
// Positions are judged on them (the bid for a long) and new ones opened at
// them (the ask for a long).

export const currentQuotes = new Map<string, Quote>();

/** A fresh quote for `symbol`, if there is one. */
export function freshQuote(symbol: string, now: number = Date.now()): Quote | undefined {
  const q = currentQuotes.get(symbol);
  return isFreshQuote(q, now) ? q : undefined;
}
