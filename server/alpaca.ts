import { usdInr } from "./fx";
import { inUsSession, usSymbol, usTicker } from "../src/shared/usMarket";

// US stock data from Alpaca (paper account, free IEX feed): 5-minute and
// 1-hour candles, and snapshots (last trade, best bid and ask). Prices come
// back in rupees, converted at the day's USD/INR rate (server/fx.ts), so the
// rest of the desk handles them like any other market.
//
// Keys: ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY (paper keys from
// alpaca.markets → Paper Trading → API Keys). The free feed is IEX: one
// exchange's quotes and volume, so spreads read wider and volume lower than
// the whole market's; fine for paper.

const DATA_URL = "https://data.alpaca.markets/v2";
const PAPER_URL = "https://paper-api.alpaca.markets/v2";
const FEED = "iex";
const MAX_PAGES = 6;

let lastError: string | null = null;
let accountStatus: string | null = null;
let lastCheckAt = 0;

export function alpacaConfigured(): boolean {
  return !!(process.env.ALPACA_API_KEY_ID?.trim() && process.env.ALPACA_API_SECRET_KEY?.trim());
}

function headers(): Record<string, string> {
  return {
    "APCA-API-KEY-ID": (process.env.ALPACA_API_KEY_ID || "").trim(),
    "APCA-API-SECRET-KEY": (process.env.ALPACA_API_SECRET_KEY || "").trim(),
    Accept: "application/json",
  };
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 200);
    try {
      message = JSON.parse(text)?.message ?? message;
    } catch {}
    lastError = res.status === 401 || res.status === 403 ? "Alpaca refused the keys: check ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY" : `Alpaca: ${message}`;
    throw new Error(lastError);
  }
  lastError = null;
  return JSON.parse(text) as T;
}

/** The rate to convert at, or an error: US prices aren't guessed without one. */
function fx(): number {
  const r = usdInr();
  if (!r) throw new Error("No USD/INR rate yet, so US prices can't be shown in rupees");
  return r;
}

export type AlpacaTimeframe = "5Min" | "1Hour";
const FRAME_MS: Record<AlpacaTimeframe, number> = { "5Min": 5 * 60 * 1000, "1Hour": 60 * 60 * 1000 };

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/**
 * Candles for several US stocks ("AAPL.US") since `fromMs`, in rupees, as
 * [openTimeMs, open, high, low, close, volume] rows per symbol (the shape the
 * candle reader takes). Regular session only: Alpaca also sends pre-market
 * and after-hours candles.
 */
export async function fetchUsCandles(symbols: string[], timeframe: AlpacaTimeframe, fromMs: number, toMs: number = Date.now()): Promise<Record<string, unknown[]>> {
  if (symbols.length === 0) return {};
  const rate = fx();
  const out: Record<string, unknown[]> = {};
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      symbols: symbols.map(usTicker).join(","),
      timeframe,
      start: new Date(fromMs).toISOString(),
      end: new Date(toMs).toISOString(),
      limit: "10000",
      adjustment: "raw",
      feed: FEED,
      sort: "asc",
    });
    if (pageToken) params.set("page_token", pageToken);
    const body = await get<{ bars?: Record<string, AlpacaBar[]>; next_page_token?: string | null }>(`${DATA_URL}/stocks/bars?${params}`);
    for (const [ticker, bars] of Object.entries(body.bars ?? {})) {
      const rows = (out[usSymbol(ticker)] ??= []);
      for (const b of bars) {
        const t = Date.parse(b.t);
        if (inUsSession(t, FRAME_MS[timeframe])) rows.push([t, b.o * rate, b.h * rate, b.l * rate, b.c * rate, b.v]);
      }
    }
    pageToken = body.next_page_token ?? null;
    if (!pageToken) break;
  }
  return out;
}

/**
 * IEX quotes wider than this (share of the mid price) are left out. IEX is
 * one exchange with a small share of trading; when it isn't quoting near the
 * whole market's best price, its bid and ask sit far apart (often 1% or more
 * on stocks whose real spread is a cent or two). Charged in the traders'
 * replay against 5-minute stops, that made every US setup lose several R, and
 * judging a position on that bid could stop it out on nothing. Without a
 * quote, a stock is priced on its last trade.
 */
export const MAX_US_QUOTE_SPREAD = 0.001;

export interface UsQuote {
  /** Last trade, in rupees. */
  price: number;
  /** Best bid and ask (IEX), in rupees, with sizes in shares; absent when IEX has no two-sided quote or a too-wide one. */
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
}

/** Last trade and best bid/ask for each US stock, in rupees: one request for all of them. */
export async function fetchUsSnapshots(symbols: string[]): Promise<Record<string, UsQuote>> {
  if (symbols.length === 0) return {};
  const rate = fx();
  const params = new URLSearchParams({ symbols: symbols.map(usTicker).join(","), feed: FEED });
  const body = await get<Record<string, any>>(`${DATA_URL}/stocks/snapshots?${params}`);
  const out: Record<string, UsQuote> = {};
  for (const [ticker, snap] of Object.entries(body ?? {})) {
    const last = Number(snap?.latestTrade?.p) || Number(snap?.minuteBar?.c);
    if (!(last > 0)) continue;
    const bp = Number(snap?.latestQuote?.bp);
    const ap = Number(snap?.latestQuote?.ap);
    const quote: UsQuote = { price: last * rate };
    if (bp > 0 && ap >= bp && (ap - bp) / ((ap + bp) / 2) <= MAX_US_QUOTE_SPREAD) {
      quote.bid = bp * rate;
      quote.ask = ap * rate;
      quote.bidSize = Number(snap?.latestQuote?.bs) || 0;
      quote.askSize = Number(snap?.latestQuote?.as) || 0;
    }
    out[usSymbol(ticker)] = quote;
  }
  return out;
}

/** Checks the keys against the paper account (at most every 10 minutes); the status page shows the result. */
export async function checkAlpacaAccount(now: number = Date.now()): Promise<void> {
  if (!alpacaConfigured() || now - lastCheckAt < 10 * 60 * 1000) return;
  lastCheckAt = now;
  try {
    const account = await get<{ status?: string }>(`${PAPER_URL}/account`);
    accountStatus = account.status ?? "UNKNOWN";
  } catch {
    accountStatus = null;
  }
}

/** For the status page. */
export function alpacaStatus() {
  return { configured: alpacaConfigured(), accountStatus, lastError };
}

/** Test hook. */
export function _resetAlpaca(): void {
  lastError = null;
  accountStatus = null;
  lastCheckAt = 0;
}
