import { fetchWithTimeout } from "../http";
import { fetchStockCandles } from "../angelOne";
import { fetchUsCandles } from "../alpaca";
import { SIGNAL_INTERVAL_MS, toClosedBars } from "../../src/services/liveMarketStreamService";
import { appendBars, emptySeries, type CandleSeries } from "../../src/services/historyReplay";

// Years of 5-minute candles for the history replay, fetched oldest first in
// pieces each source allows, with a pause between requests:
// - Coins from Binance (COINUSDT): CoinDCX keeps only recent INR candles.
//   A coin's moves in dollars track its INR market closely, and the replay
//   counts results in R, so the currency doesn't matter.
// - US stocks from Alpaca (the free IEX feed, as live), regular session only.
// - Indian stocks from Angel One, at most 100 days a request.
// A piece that comes back empty is skipped (the source has nothing that far
// back); one that fails stops that market's download.

const DAY_MS = 24 * 60 * 60 * 1000;
/** Binance's public market data (no key needed), and its main address as a fallback. */
export const BINANCE_HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];
const BINANCE_LIMIT = 1000;
/** Days per request: Angel One allows 100 of 5-minute candles; Alpaca's pages hold 10,000 candles. */
const NSE_CHUNK_DAYS = 90;
const US_CHUNK_DAYS = 120;
/** Waits between requests, kind to each source's limits. */
const PAUSE_MS = { binance: 200, alpaca: 400 };

export type Pause = (ms: number) => Promise<void>;
const sleep: Pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A market's candles between two times, or why they couldn't be fetched. */
export type HistoryFetch = { series: CandleSeries } | { error: string };

let binanceHost = BINANCE_HOSTS[0];

/** The coin's Binance pair, e.g. "BTC/INR" → "BTCUSDT". */
export const binancePair = (symbol: string) => `${symbol.split("/")[0].toUpperCase()}USDT`;

async function binancePage(pair: string, startMs: number, endMs: number, interval: "5m" | "1d" = "5m"): Promise<{ rows: unknown[] } | { error: string; unknownPair?: boolean }> {
  const query = `/api/v3/klines?symbol=${pair}&interval=${interval}&startTime=${startMs}&endTime=${endMs}&limit=${BINANCE_LIMIT}`;
  let last = "";
  // The host that last worked first, then the other.
  for (const host of [binanceHost, ...BINANCE_HOSTS.filter((h) => h !== binanceHost)]) {
    try {
      const res = await fetchWithTimeout(`${host}${query}`);
      const text = await res.text();
      if (res.ok) {
        binanceHost = host;
        const rows = JSON.parse(text);
        return { rows: Array.isArray(rows) ? rows : [] };
      }
      // {"code":-1121,"msg":"Invalid symbol."}: the coin isn't on Binance.
      if (res.status === 400 && /invalid symbol/i.test(text)) return { error: `${pair} isn't on Binance`, unknownPair: true };
      last = `Binance: HTTP ${res.status} ${text.slice(0, 120)}`;
    } catch (err: any) {
      last = `Binance: ${err?.message || "no reply"}`;
    }
  }
  return { error: last };
}

/**
 * A coin's last `days` daily candles from Binance (COINUSDT, UTC days, as
 * the replay builds them), closed by `now`: what the daily coin trades read.
 */
export async function fetchCoinDaily(symbol: string, days: number, now: number): Promise<HistoryFetch> {
  const page = await binancePage(binancePair(symbol), now - Math.min(days, BINANCE_LIMIT) * DAY_MS, now, "1d");
  if ("error" in page) return { error: page.error };
  const series = emptySeries();
  appendBars(series, toClosedBars(page.rows, DAY_MS, now));
  return { series };
}

/** A coin's 5-minute candles from Binance (COINUSDT), from `fromMs` to `toMs`. */
export async function fetchCoinHistory(symbol: string, fromMs: number, toMs: number, pause: Pause = sleep): Promise<HistoryFetch> {
  const pair = binancePair(symbol);
  const series = emptySeries();
  for (let start = fromMs; start < toMs; ) {
    const page = await binancePage(pair, start, toMs);
    if ("error" in page) return { error: page.error };
    const bars = toClosedBars(page.rows, SIGNAL_INTERVAL_MS, toMs);
    appendBars(series, bars);
    // Binance starts at the first candle it has from `start` (a coin listed later starts at its listing).
    const last = series.t[series.t.length - 1];
    if (page.rows.length < BINANCE_LIMIT || last === undefined || last + SIGNAL_INTERVAL_MS <= start) break;
    start = last + SIGNAL_INTERVAL_MS;
    await pause(PAUSE_MS.binance);
  }
  return { series };
}

/** A US stock's 5-minute regular-session candles from Alpaca (in rupees at today's rate; the replay counts in R). */
export async function fetchUsHistory(symbol: string, fromMs: number, toMs: number, pause: Pause = sleep): Promise<HistoryFetch> {
  const series = emptySeries();
  try {
    for (let start = fromMs; start < toMs; start += US_CHUNK_DAYS * DAY_MS) {
      const end = Math.min(toMs, start + US_CHUNK_DAYS * DAY_MS);
      const rows = await fetchUsCandles([symbol], "5Min", start, end);
      appendBars(series, toClosedBars(rows[symbol] ?? [], SIGNAL_INTERVAL_MS, end));
      await pause(PAUSE_MS.alpaca);
    }
  } catch (err: any) {
    return { error: err?.message || "Couldn't reach Alpaca" };
  }
  return { series };
}

/** Angel One refusals that stop the download (to try again later), rather than a piece it has no candles for. */
const NSE_STOPS = /slow down|isn't set up|isn't listed|log ?in|session|token|HTTP 5\d\d|abort|timeout|fetch failed/i;

/**
 * An Indian stock's 5-minute candles from Angel One (its own spacing keeps
 * to Angel One's limits). It may answer a piece too far back with an error
 * rather than no candles, so such a piece is skipped.
 */
export async function fetchNseHistory(symbol: string, fromMs: number, toMs: number): Promise<HistoryFetch> {
  const series = emptySeries();
  let lastError: string | null = null;
  for (let start = fromMs; start < toMs; start += NSE_CHUNK_DAYS * DAY_MS) {
    const end = Math.min(toMs, start + NSE_CHUNK_DAYS * DAY_MS);
    try {
      appendBars(series, toClosedBars(await fetchStockCandles(symbol, "FIVE_MINUTE", start, end), SIGNAL_INTERVAL_MS, end));
    } catch (err: any) {
      lastError = err?.message || "Couldn't reach Angel One";
      if (NSE_STOPS.test(lastError!)) return { error: lastError! };
    }
  }
  return series.t.length === 0 && lastError ? { error: lastError } : { series };
}

/** Test hook. */
export function _resetHistoryCandles(): void {
  binanceHost = BINANCE_HOSTS[0];
}
