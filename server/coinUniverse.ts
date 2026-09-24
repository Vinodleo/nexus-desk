import { getCoinDcxTicker } from "./coindcxTicker";
import { getMarketRules } from "./marketRules";
import { defaultUniverse, pickTopCoins, type CoinUniverse } from "../src/shared/coinUniverse";

// The coins the app scans and streams prices for, picked hourly from CoinDCX's
// ticker. If the ticker can't be read, the default list is used and another
// try is made after a few minutes.

const REFRESH_MS = 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;

let cache: CoinUniverse | null = null;
let inFlight: Promise<CoinUniverse> | null = null;

export async function getCoinUniverse(now: number = Date.now()): Promise<CoinUniverse> {
  if (cache && now - cache.updatedAt < (cache.fallback ? RETRY_MS : REFRESH_MS)) return cache;
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const [tickers, rules] = await Promise.all([getCoinDcxTicker(), getMarketRules()]);
        const coins = pickTopCoins(tickers, { activeMarkets: new Set(rules.keys()) });
        if (coins.length === 0) throw new Error("no INR coins passed the volume filter");
        cache = { coins, updatedAt: Date.now(), fallback: false };
        console.log(`[Universe] Watching ${coins.length} coins: ${coins.map((c) => c.symbol.split("/")[0]).join(", ")}`);
      } catch (err: any) {
        console.warn(`[Universe] ${err?.message || err}; ${cache && !cache.fallback ? "keeping the last list" : "using the default coins"}`);
        cache = cache && !cache.fallback ? { ...cache, updatedAt: Date.now() - REFRESH_MS + RETRY_MS } : defaultUniverse();
      }
      return cache!;
    })().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

/** Test hook. */
export function _resetCoinUniverse() {
  cache = null;
  inFlight = null;
}
