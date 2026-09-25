import { angelConfigured, fetchStockQuotes } from "./angelOne";
import { currentQuotes } from "./quoteStore";
import { recordSpread } from "./scanner/scannerService";
import { spreadPct, type Quote } from "../src/shared/quotes";
import { broadcast, currentPrices } from "./realtime";
import { daemonPositions, evaluateDaemonPositions } from "./guardian";
import { isNseOpen, isNseSymbol } from "../src/shared/nse";
import { stockUniverse } from "./scanner/scannerService";

// Live NSE stock prices from Angel One, every few seconds while the market is
// open: the same job the CoinDCX relay does for coins. Each price goes to the
// position guardian (stops, targets, trailing), to the scanner's entry price,
// and to every open app.
//
// With each price come the best bid and offer (Angel One's FULL quote, one
// request per 50 stocks like prices alone). As for coins, positions are
// judged on the price they could be closed at (the bid for a long), new ones
// open at the ask, and each stock's spread is recorded for the traders'
// replay.

const POLL_MS = 5000;

/** One round: prices for the scanned stocks and any stock still held. Returns how many arrived. */
export async function pollStockPrices(now: number = Date.now()): Promise<number> {
  if (!angelConfigured() || !isNseOpen(now)) return 0;
  const held = [...daemonPositions.values()].map((p) => p.symbol).filter(isNseSymbol);
  const symbols = [...new Set([...stockUniverse(), ...held])];
  if (symbols.length === 0) return 0;
  const rows = await fetchStockQuotes(symbols);
  const prices: Record<string, number> = {};
  const quotes: Record<string, Quote> = {};
  for (const [sym, row] of Object.entries(rows)) {
    prices[sym] = row.ltp;
    currentPrices[sym] = row.ltp;
    let quote: Quote | undefined;
    if (row.bid !== undefined && row.ask !== undefined) {
      quote = { bid: row.bid, ask: row.ask, at: now };
      currentQuotes.set(sym, quote);
      recordSpread(sym, spreadPct(quote));
      quotes[sym] = quote;
    }
    evaluateDaemonPositions(sym, row.ltp, quote);
  }
  if (Object.keys(prices).length > 0) broadcast({ type: "TICK", data: prices });
  if (Object.keys(quotes).length > 0) broadcast({ type: "QUOTE", data: quotes });
  return Object.keys(prices).length;
}

export function startStockPrices(): void {
  if (!angelConfigured()) {
    console.log("[AngelOne] Not set up (ANGEL_* settings); Indian stocks aren't scanned.");
    return;
  }
  let running = false;
  let warnedAt = 0;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await pollStockPrices();
    } catch (err: any) {
      // At most one warning a minute.
      if (Date.now() - warnedAt > 60_000) {
        warnedAt = Date.now();
        console.warn("[AngelOne] Price poll failed:", err?.message ?? err);
      }
    } finally {
      running = false;
    }
  }, POLL_MS);
  console.log("[AngelOne] Scanning Nifty 50 stocks while NSE is open.");
}
