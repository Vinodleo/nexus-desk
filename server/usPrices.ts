import { alpacaConfigured, fetchUsSnapshots } from "./alpaca";
import { broadcast, currentPrices } from "./realtime";
import { daemonPositions, evaluateDaemonPositions } from "./guardian";
import { currentQuotes } from "./quoteStore";
import { recordSpread, usUniverse } from "./scanner/scannerService";
import { isUsOpen, isUsSymbol } from "../src/shared/usMarket";
import { isFreshQuote, spreadPct, type Quote } from "../src/shared/quotes";
import type { RawBook } from "../src/shared/orderBook";

// Live US stock prices from Alpaca (paper account, free IEX feed), every few
// seconds while the US market is open: the same job the Angel One poller
// does for Indian stocks. One snapshot request covers every US stock: the
// last trade and the best bid and ask, in rupees. Positions are judged on
// the price they could be closed at (the bid for a long), new ones open at
// the ask, each stock's spread is recorded for the traders' replay, and
// every open app hears of them.

const POLL_MS = 5000;

/** The latest bid and ask sizes (shares) per US stock: the scanner's one-level order book. */
const sizes = new Map<string, { bid: number; ask: number }>();

/** One round: prices for the scanned US stocks and any still held. Returns how many arrived. */
export async function pollUsPrices(now: number = Date.now()): Promise<number> {
  if (!alpacaConfigured() || !isUsOpen(now)) return 0;
  const held = [...daemonPositions.values()].map((p) => p.symbol).filter(isUsSymbol);
  const symbols = [...new Set([...usUniverse(), ...held])];
  if (symbols.length === 0) return 0;
  const snaps = await fetchUsSnapshots(symbols);
  const prices: Record<string, number> = {};
  const quotes: Record<string, Quote> = {};
  for (const [sym, snap] of Object.entries(snaps)) {
    prices[sym] = snap.price;
    currentPrices[sym] = snap.price;
    let quote: Quote | undefined;
    if (snap.bid !== undefined && snap.ask !== undefined) {
      quote = { bid: snap.bid, ask: snap.ask, at: now };
      currentQuotes.set(sym, quote);
      sizes.set(sym, { bid: snap.bidSize ?? 0, ask: snap.askSize ?? 0 });
      recordSpread(sym, spreadPct(quote));
      quotes[sym] = quote;
    }
    evaluateDaemonPositions(sym, snap.price, quote);
  }
  if (Object.keys(prices).length > 0) broadcast({ type: "TICK", data: prices });
  if (Object.keys(quotes).length > 0) broadcast({ type: "QUOTE", data: quotes });
  return Object.keys(prices).length;
}

/**
 * A US stock's order book for the scanner: the latest best bid and ask
 * (IEX) with their sizes, a round lot (100 shares) when IEX gave none. Null
 * without a fresh quote.
 */
export function usQuoteBook(symbol: string, now: number = Date.now()): RawBook | null {
  const q = currentQuotes.get(symbol);
  if (!isFreshQuote(q, now)) return null;
  const s = sizes.get(symbol);
  return { bids: [[q.bid, s?.bid || 100]], asks: [[q.ask, s?.ask || 100]], fetchedAt: q.at };
}

export function startUsPrices(): void {
  if (!alpacaConfigured()) {
    console.log("[Alpaca] Not set up (ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY); US stocks aren't scanned.");
    return;
  }
  let running = false;
  let warnedAt = 0;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await pollUsPrices();
    } catch (err: any) {
      if (Date.now() - warnedAt > 60_000) {
        warnedAt = Date.now();
        console.warn("[Alpaca] Price poll failed:", err?.message ?? err);
      }
    } finally {
      running = false;
    }
  }, POLL_MS);
  console.log("[Alpaca] Scanning US stocks (paper, prices in rupees) while the US market is open.");
}

/** Test hook. */
export function _resetUsPrices(): void {
  sizes.clear();
}
