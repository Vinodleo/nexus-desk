import type { OrderBook } from "../types";
import { apiFetch } from "./apiClient";
import { bookStats, type BookLevel, type RawBook } from "../shared/orderBook";

// CoinDCX's live order book, turned into the spread, slippage and depth the
// scanner's cost and liquidity checks use. Only read for coins with a setup.

/** A book older than this is treated as unavailable. */
const MAX_BOOK_AGE_MS = 15_000;
const LEVELS_SHOWN = 10;

function levels(side: BookLevel[]) {
  let total = 0;
  return side.slice(0, LEVELS_SHOWN).map(([price, size]) => {
    total += size;
    return { price, size, total };
  });
}

/** Builds the scanner's order book from CoinDCX's, for a trade worth `notional` rupees. */
export function toOrderBook(book: RawBook, notional: number, source: "coindcx" | "angelone" | "alpaca" = "coindcx"): OrderBook {
  const s = bookStats(book, notional);
  return {
    bids: levels(book.bids),
    asks: levels(book.asks),
    spread: s.spread,
    midPrice: s.mid,
    depthScore: s.depthScore,
    source,
    spreadPct: s.spreadPct,
    roundTripSlippage: s.roundTripSlippage,
    depthInr: s.depthInr,
    fetchedAt: book.fetchedAt,
  };
}

/** The live book for a crypto symbol like "BTC/INR", or null if it can't be read. */
export async function fetchLiveOrderBook(symbol: string, notional: number, nowMs: () => number = Date.now): Promise<OrderBook | null> {
  const base = symbol.split("/")[0];
  if (!symbol.includes("/") || !/^[A-Z0-9]{1,15}$/.test(base)) return null;
  try {
    const res = await apiFetch(`/api/coindcx/orderbook?symbol=${base}`);
    if (!res.ok) return null;
    const book = (await res.json()) as RawBook;
    if (!Array.isArray(book?.bids) || !Array.isArray(book?.asks) || book.bids.length === 0 || book.asks.length === 0) return null;
    if (nowMs() - (book.fetchedAt ?? 0) > MAX_BOOK_AGE_MS) return null;
    return toOrderBook(book, notional);
  } catch {
    return null;
  }
}
