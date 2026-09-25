import { entryPriceFrom, isFreshQuote, type Quote } from "../shared/quotes";
import { isNseSymbol } from "../shared/nse";
import { fetchLiveOrderBook } from "./orderBookService";
import { liveMarketStream } from "./liveMarketStreamService";

/**
 * The price a new position would open at now: the ask for a long (the bid
 * for a short). For a coin, from CoinDCX's order book; for a stock, from the
 * latest Angel One quote the server sent. The last trade when neither is at
 * hand.
 */
export async function entryPriceNow(
  symbol: string,
  direction: "LONG" | "SHORT",
  notional: number,
  quote?: Quote
): Promise<number | undefined> {
  if (isNseSymbol(symbol)) {
    if (isFreshQuote(quote)) return entryPriceFrom(direction, quote);
    return liveMarketStream.getLastPrice(symbol);
  }
  const book = await fetchLiveOrderBook(symbol, notional).catch(() => null);
  if (book && book.asks.length > 0 && book.bids.length > 0) return direction === "LONG" ? book.asks[0].price : book.bids[0].price;
  return liveMarketStream.getLastPrice(symbol);
}
