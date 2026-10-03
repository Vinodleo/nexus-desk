import { inflateRawSync } from "zlib";
import { fetchWithTimeout } from "../http";
import { fetchStockCandles } from "../angelOne";
import { fetchUsCandles, fetchUsDailyBars } from "../alpaca";
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
/** Days per request: Angel One allows 100 of 5-minute candles (2,000 of daily ones); Alpaca's pages hold 10,000 candles. */
const NSE_CHUNK_DAYS = 90;
const NSE_DAILY_CHUNK_DAYS = 1800;
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
  const got = await binanceCandles(binancePair(symbol), "5m", fromMs, toMs, pause);
  return "error" in got ? { error: got.error } : got;
}

/** A pair's candles from Binance's API, page by page, from `fromMs` to `toMs` (closed by then). */
async function binanceCandles(
  pair: string,
  interval: "5m" | "1d",
  fromMs: number,
  toMs: number,
  pause: Pause
): Promise<{ series: CandleSeries } | { error: string; unknownPair?: boolean }> {
  const intervalMs = interval === "5m" ? SIGNAL_INTERVAL_MS : DAY_MS;
  const series = emptySeries();
  for (let start = fromMs; start < toMs; ) {
    const page = await binancePage(pair, start, toMs, interval);
    if ("error" in page) return page;
    appendBars(series, toClosedBars(page.rows, intervalMs, toMs));
    // Binance starts at the first candle it has from `start` (a coin listed later starts at its listing).
    const last = series.t[series.t.length - 1];
    if (page.rows.length < BINANCE_LIMIT || last === undefined || last + intervalMs <= start) break;
    start = last + intervalMs;
    await pause(PAUSE_MS.binance);
  }
  return { series };
}

// ---------- daily candles over every year Binance has ----------
// The long daily replay (history/dailyLong.ts) reads coins back to 2017,
// including coins Binance has since delisted (their candles are only in its
// download archive, a zip file a month) and coins that traded under another
// pair name for a while.

/** Where a coin traded under other pairs, oldest first (each read up to `untilMs`); otherwise COINUSDT throughout. */
export const DAILY_PAIRS: Record<string, { pair: string; untilMs?: number }[]> = {
  // Bitcoin Cash was BCC, then BCHABC after the 2018 split.
  BCH: [{ pair: "BCCUSDT" }, { pair: "BCHABCUSDT" }, { pair: "BCHUSDT" }],
  BSV: [{ pair: "BCHSVUSDT" }],
  // Polygon swapped MATIC for POL one for one (September 2024).
  MATIC: [{ pair: "MATICUSDT" }, { pair: "POLUSDT" }],
  NANO: [{ pair: "NANOUSDT" }, { pair: "XNOUSDT" }],
  // Terra's LUNA until its collapse in May 2022 (the name went to a new coin later).
  LUNA: [{ pair: "LUNAUSDT", untilMs: Date.UTC(2022, 5, 1) }],
};

const ARCHIVE_URL = "https://data.binance.vision/data/spot/monthly/klines";

/** The first file in a zip archive, or null if it can't be read. */
export function unzipFirst(zip: Buffer): Buffer | null {
  try {
    // The end-of-directory record points at the directory, whose first entry gives the file's size and where it starts.
    const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0 || end + 22 > zip.length) return null;
    const dir = zip.readUInt32LE(end + 16);
    if (zip.readUInt32LE(dir) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(dir + 10);
    const size = zip.readUInt32LE(dir + 20);
    const local = zip.readUInt32LE(dir + 42);
    if (zip.readUInt32LE(local) !== 0x04034b50) return null;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    return method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : null;
  } catch {
    return null;
  }
}

/** Kline rows from an archive's CSV: times in ms (the files switched to microseconds in 2025). */
function archiveRows(csv: string): unknown[] {
  return csv
    .split("\n")
    .map((line) => line.trim().split(","))
    .filter((f) => f.length >= 6 && /^\d+$/.test(f[0]))
    .map(([t, o, h, l, c, v]) => [Number(t) > 1e14 ? Math.floor(Number(t) / 1000) : Number(t), o, h, l, c, v]);
}

/** A pair's daily candles from Binance's monthly archive files, from `fromMs` to `toMs`. */
async function archiveDaily(pair: string, fromMs: number, toMs: number, pause: Pause): Promise<HistoryFetch> {
  const series = emptySeries();
  const first = new Date(fromMs);
  let found = false;
  for (let y = first.getUTCFullYear(), m = first.getUTCMonth(); Date.UTC(y, m, 1) < toMs; m === 11 ? ((y += 1), (m = 0)) : (m += 1)) {
    const month = `${y}-${String(m + 1).padStart(2, "0")}`;
    let res: Response;
    try {
      res = await fetchWithTimeout(`${ARCHIVE_URL}/${pair}/1d/${pair}-1d-${month}.zip`);
    } catch (err: any) {
      return { error: `Binance archive: ${err?.message || "no reply"}` };
    }
    await pause(PAUSE_MS.binance);
    // No file: the pair didn't trade that month.
    if (res.status === 404) continue;
    if (!res.ok) return { error: `Binance archive: HTTP ${res.status} for ${pair} ${month}` };
    const csv = unzipFirst(Buffer.from(await res.arrayBuffer()));
    if (!csv) return { error: `Binance archive: couldn't read ${pair} ${month}` };
    const last = series.t[series.t.length - 1] ?? -Infinity;
    appendBars(series, toClosedBars(archiveRows(csv.toString()), DAY_MS, toMs).filter((b) => (b.timestampMs as number) >= fromMs && (b.timestampMs as number) > last));
    found = true;
  }
  return found ? { series } : { error: `${pair} isn't on Binance` };
}

/**
 * A coin's daily candles from `fromMs` to `toMs` (UTC days, closed by then):
 * from Binance's API, or its archive for a pair it no longer lists, across
 * the pairs the coin traded under (DAILY_PAIRS).
 */
export async function fetchCoinDailySince(symbol: string, fromMs: number, toMs: number, pause: Pause = sleep): Promise<HistoryFetch> {
  const base = symbol.split("/")[0].toUpperCase();
  const series = emptySeries();
  const errors: string[] = [];
  for (const { pair, untilMs } of DAILY_PAIRS[base] ?? [{ pair: binancePair(symbol) }]) {
    const last = series.t[series.t.length - 1];
    const from = last === undefined ? fromMs : last + DAY_MS;
    const to = Math.min(toMs, untilMs ?? Infinity);
    if (from >= to) continue;
    const api = await binanceCandles(pair, "1d", from, to, pause);
    // A pair Binance no longer lists: its archive.
    const got: HistoryFetch = "error" in api ? (api.unknownPair ? await archiveDaily(pair, from, to, pause) : { error: api.error }) : api;
    if ("error" in got) {
      errors.push(got.error);
      continue;
    }
    appendBars(series, got.series.t.map((t, k) => ({ time: "", timestampMs: t, open: got.series.o[k], high: got.series.h[k], low: got.series.l[k], close: got.series.c[k], volume: got.series.v[k] })));
  }
  return series.t.length > 0 ? { series } : { error: errors[0] ?? `${binancePair(symbol)} isn't on Binance` };
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

/** A US stock's daily candles from Alpaca, in dollars, adjusted for splits and dividends (the stocks' long replay). */
export async function fetchUsDaily(symbol: string, fromMs: number, toMs: number): Promise<HistoryFetch> {
  try {
    const series = emptySeries();
    appendBars(series, toClosedBars(await fetchUsDailyBars(symbol, fromMs, toMs), DAY_MS, toMs));
    return series.t.length > 0 ? { series } : { error: `Alpaca has no daily candles for ${symbol.replace(/\.US$/, "")}` };
  } catch (err: any) {
    return { error: err?.message || "Couldn't reach Alpaca" };
  }
}

/**
 * An Indian stock's daily candles from Angel One, in pieces it allows. A
 * piece it has nothing for (before the stock listed) is skipped; a refusal
 * that means "later" stops the download.
 */
export async function fetchNseDaily(symbol: string, fromMs: number, toMs: number): Promise<HistoryFetch> {
  const series = emptySeries();
  let lastError: string | null = null;
  for (let start = fromMs; start < toMs; start += NSE_DAILY_CHUNK_DAYS * DAY_MS) {
    const end = Math.min(toMs, start + NSE_DAILY_CHUNK_DAYS * DAY_MS);
    try {
      appendBars(series, toClosedBars(await fetchStockCandles(symbol, "ONE_DAY", start, end), DAY_MS, end));
    } catch (err: any) {
      lastError = err?.message || "Couldn't reach Angel One";
      if (NSE_STOPS.test(lastError!)) return { error: lastError! };
    }
  }
  if (series.t.length > 0) return { series };
  return { error: lastError ?? `Angel One has no daily candles for ${symbol}` };
}

/** Test hook. */
export function _resetHistoryCandles(): void {
  binanceHost = BINANCE_HOSTS[0];
}
