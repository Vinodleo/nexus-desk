import { angelConfigured, fetchStockPrices } from "./angelOne";
import { broadcast, currentPrices } from "./realtime";
import { daemonPositions, evaluateDaemonPositions } from "./guardian";
import { isNseOpen, isNseSymbol } from "../src/shared/nse";
import { stockUniverse } from "./scanner/scannerService";

// Live NSE stock prices from Angel One, every few seconds while the market is
// open: the same job the CoinDCX relay does for coins. Each price goes to the
// position guardian (stops, targets, trailing), to the scanner's entry price,
// and to every open app.

const POLL_MS = 5000;

/** One round: prices for the scanned stocks and any stock still held. Returns how many arrived. */
export async function pollStockPrices(now: number = Date.now()): Promise<number> {
  if (!angelConfigured() || !isNseOpen(now)) return 0;
  const held = [...daemonPositions.values()].map((p) => p.symbol).filter(isNseSymbol);
  const symbols = [...new Set([...stockUniverse(), ...held])];
  if (symbols.length === 0) return 0;
  const prices = await fetchStockPrices(symbols);
  for (const [sym, price] of Object.entries(prices)) {
    currentPrices[sym] = price;
    evaluateDaemonPositions(sym, price);
  }
  if (Object.keys(prices).length > 0) broadcast({ type: "TICK", data: prices });
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
