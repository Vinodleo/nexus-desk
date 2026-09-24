import { aggregateMinuteCandles } from "./candles";
import { parseCoinDcxOrderBook, type RawBook } from "../src/shared/orderBook";

// CoinDCX's public candles and order books for INR markets, used by the
// /api/coindcx routes and by the server-side scanner.

export interface CandleFetchResult {
  pair: string;
  interval: string;
  status: number;
  text: string;
  /** CoinDCX's candles, newest first; null when the request failed. */
  list: unknown[] | null;
}

async function fetchCandles(pair: string, interval: string, limit: number): Promise<CandleFetchResult> {
  const params = new URLSearchParams({ pair, interval, limit: String(limit) });
  const response = await fetch(`https://public.coindcx.com/market_data/candles?${params}`);
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  // Normally a bare array; accept { data: [...] } too.
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { data?: unknown }).data)
    ? (data as { data: unknown[] }).data
    : null;
  return { pair, interval, status: response.status, text, list: response.ok ? list : null };
}

/**
 * Candles for a coin's INR market, newest first. CoinDCX has no 5-minute INR
 * candles, so those are built from 1-minute ones.
 */
export async function fetchCoinCandles(coin: string, interval: string, limit: number): Promise<CandleFetchResult> {
  const pair = `I-${coin}_INR`;
  const wanted = Math.min(1000, Math.max(1, limit));
  if (interval === "5m") {
    let result = await fetchCandles(pair, "1m", Math.min(1000, wanted * 5 + 5));
    if (!result.list) result = await fetchCandles(pair, "1m", 500);
    if (!result.list) return { ...result, interval: "5m" };
    return { ...result, interval: "5m", list: aggregateMinuteCandles(result.list, 5).slice(0, wanted) };
  }
  return fetchCandles(pair, interval, wanted);
}

export function describeCandleError(r: CandleFetchResult): string {
  return `CoinDCX candles (${r.pair}, ${r.interval}): HTTP ${r.status} ${r.text.slice(0, 160)}`;
}

// Order books are kept for a couple of seconds so a burst of requests makes
// one call to CoinDCX.
const BOOK_CACHE_MS = 2000;
const bookCache = new Map<string, RawBook>();

/** A coin's live INR order book, or an error message. */
export async function fetchOrderBook(coin: string): Promise<{ book: RawBook } | { error: string }> {
  const pair = `I-${coin}_INR`;
  const cached = bookCache.get(pair);
  if (cached && Date.now() - cached.fetchedAt < BOOK_CACHE_MS) return { book: cached };
  try {
    const response = await fetch(`https://public.coindcx.com/market_data/orderbook?pair=${encodeURIComponent(pair)}`);
    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    const book = response.ok ? parseCoinDcxOrderBook(data) : null;
    if (!book) return { error: `CoinDCX order book (${pair}): HTTP ${response.status} ${text.slice(0, 160)}` };
    bookCache.set(pair, book);
    return { book };
  } catch (error: any) {
    return { error: error?.message || "Failed to fetch the order book from CoinDCX" };
  }
}
