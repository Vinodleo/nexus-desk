import { fetchOrderBook } from "./coindcxMarketData";
import { daemonPositions, evaluateDaemonPositions } from "./guardian";
import { broadcast } from "./realtime";
import { isFreshQuote, spreadPct, type Quote } from "../src/shared/quotes";
import { recordSpread } from "./scanner/scannerService";

// Best bid and ask for every coin a position is held in, read from CoinDCX's
// order book every few seconds. The guardian judges positions on these (the
// bid for a long) rather than on trade prints, which jump between the bid
// and the ask; the app gets them too, so both judge the same price.

const POLL_MS = 3000;

export const currentQuotes = new Map<string, Quote>();

/** A fresh quote for `symbol`, if there is one. */
export function freshQuote(symbol: string, now: number = Date.now()): Quote | undefined {
  const q = currentQuotes.get(symbol);
  return isFreshQuote(q, now) ? q : undefined;
}

/** Coins held in a guarded position (CoinDCX INR coins only; stocks trade on tight spreads). */
function heldCoins(): string[] {
  return [...new Set([...daemonPositions.values()].map((p) => p.symbol))].filter((s) => /^[A-Z0-9]{1,15}\/INR$/.test(s));
}

/** One round: quotes for the held coins, the guardian judged on them, and the app told. */
export async function pollQuotes(now: number = Date.now()): Promise<number> {
  const out: Record<string, Quote> = {};
  for (const symbol of heldCoins()) {
    const result = await fetchOrderBook(symbol.split("/")[0]);
    if (!("book" in result) || result.book.bids.length === 0 || result.book.asks.length === 0) continue;
    const quote: Quote = { bid: result.book.bids[0][0], ask: result.book.asks[0][0], at: result.book.fetchedAt || now };
    if (!isFreshQuote(quote, Math.max(now, quote.at))) continue;
    currentQuotes.set(symbol, quote);
    recordSpread(symbol, spreadPct(quote));
    out[symbol] = quote;
    evaluateDaemonPositions(symbol, quote.bid, quote);
  }
  if (Object.keys(out).length > 0) broadcast({ type: "QUOTE", data: out });
  return Object.keys(out).length;
}

export function startQuotes(): void {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await pollQuotes();
    } catch (err: any) {
      console.warn("[Quotes] Poll failed:", err?.message ?? err);
    } finally {
      running = false;
    }
  }, POLL_MS);
}

/** Test hook. */
export function _resetQuotes(): void {
  currentQuotes.clear();
}
