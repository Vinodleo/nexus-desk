// CoinDCX's public ticker, shared. Browsers poll /api/coindcx/ticker every
// few seconds per tab and live orders look up reference prices, so without a
// cache every one of those hit CoinDCX separately. Responses are reused for
// TICKER_TTL_MS and concurrent callers share a single in-flight request.

const TICKER_URL = "https://public.coindcx.com/exchange/ticker";
export const TICKER_TTL_MS = 2000;

let cached: { at: number; data: unknown[] } | null = null;
let inFlight: Promise<unknown[]> | null = null;

export async function getCoinDcxTicker(now: number = Date.now()): Promise<unknown[]> {
  if (cached && now - cached.at < TICKER_TTL_MS) return cached.data;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const response = await fetch(TICKER_URL);
      if (!response.ok) throw new Error(`CoinDCX ticker returned ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data)) throw new Error("CoinDCX ticker returned an unexpected shape");
      cached = { at: Date.now(), data };
      return data;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// For tests.
export function resetTickerCache() {
  cached = null;
  inFlight = null;
}
