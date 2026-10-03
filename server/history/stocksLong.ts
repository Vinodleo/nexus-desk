import fs from "fs";
import path from "path";
import type { CandleSeries } from "../../src/services/historyReplay";
import { addClassicTrades, breakoutTrades, maTrendTrades, momentumTrades, stockWeekClose, uptrend, type ClassicRecords } from "../../src/services/classicStrategies";
import { roundTripFeeRate } from "../../src/shared/tradeCosts";
import { nseDeliveryRoundTripRate } from "../../src/shared/nse";
import { fetchNseDaily, fetchUsDaily, type HistoryFetch } from "./historyCandles";
import { backgroundWorkBusy, CPU_SHARE, historyRunning, nseBusy, SLOW_NSE_TRADE_INR, UNREAD_STOCK_SPREAD, waitForOtherWork } from "./historyJob";
import { CLASSIC_VERSION } from "./dailyLong";
import { breakoutSetups, marketCandles, type BreakoutSetup } from "../../src/services/breakoutModel";
import { saveBreakoutSetups } from "./breakoutSetups";
import { scannerHeartbeat } from "../scanner/scannerService";

// The classic strategies (src/services/classicStrategies.ts) on US and
// Indian stocks' daily candles since 2016: whether breakout 55/20, moving
// averages 50/200 or momentum would earn on stocks, where the desk's
// 5-minute traders lost their costs, after the same kind of costs (Alpaca's
// fees and a spread; for India, delivery charges, as a trade held overnight).
//
// As with the coins, each year trades only its 20 biggest stocks on
// 1 January (STOCK_COHORTS), so today's winners aren't replayed in the years
// before they grew. Each market's index fund (SPY, the Nifty ETF) stands in
// for Bitcoin as the market's 200-day guard. US candles come adjusted for
// splits and dividends; Angel One's aren't, so splits and bonus issues are
// found in its candles and the earlier prices adjusted (adjustForSplits).
//
// It runs in the background like the other replays, at CPU_SHARE of a core,
// never alongside them, and again monthly. Indian downloads wait for NSE to
// close. Its results decide nothing: paper trading follows only if a
// strategy clearly beats its costs, and only when the owner says so.

/** Bump when the replay changes enough that old results no longer compare. */
export const STOCKS_LONG_VERSION = 1;
/** A year of warm-up (the 200-day average) before the first lists, 2016's. */
export const STOCKS_FROM_MS = Date.UTC(2015, 0, 1);
const RERUN_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const START_DELAY_MS = 30 * 60 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const CYCLE_WAIT_MS = 500;
const NSE_WAIT_MS = 5 * 60 * 1000;
/** Between downloads, kind to each source's limits. */
const PAUSE_MS = 1000;
/** Failed stocks are tried once more after this pause. */
const RETRY_AFTER_MS = 10 * 60 * 1000;
/** A stock with less than a year of candles isn't replayed. */
const MIN_DAYS = 250;
const DAY_MS = 24 * 60 * 60 * 1000;

export type StockMarket = "us" | "nse";
export const STOCK_MARKETS: StockMarket[] = ["us", "nse"];

/**
 * The 20 biggest stocks by market value on 1 January each year, from memory
 * of the rankings of the time: US (any exchange) and India (in the Nifty 50).
 * Picked by size then, not by how they did after. Later years use the last.
 */
export const STOCK_COHORTS: Record<StockMarket, Record<number, string[]>> = {
  us: {
    2016: ["AAPL", "GOOGL", "MSFT", "BRK.B", "XOM", "AMZN", "META", "GE", "JNJ", "WFC", "JPM", "T", "PG", "WMT", "VZ", "PFE", "CVX", "KO", "ORCL", "INTC"],
    2017: ["AAPL", "GOOGL", "MSFT", "BRK.B", "AMZN", "XOM", "META", "JNJ", "JPM", "GE", "WFC", "T", "BAC", "PG", "CVX", "WMT", "VZ", "PFE", "INTC", "MRK"],
    2018: ["AAPL", "GOOGL", "MSFT", "AMZN", "META", "BRK.B", "JNJ", "JPM", "XOM", "BAC", "WFC", "WMT", "V", "INTC", "CVX", "T", "HD", "UNH", "PFE", "PG"],
    2019: ["MSFT", "AAPL", "AMZN", "GOOGL", "BRK.B", "META", "JNJ", "JPM", "XOM", "V", "WMT", "PG", "BAC", "VZ", "PFE", "UNH", "CVX", "INTC", "T", "MA"],
    2020: ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "BRK.B", "JPM", "V", "JNJ", "WMT", "PG", "MA", "XOM", "BAC", "INTC", "T", "HD", "UNH", "DIS", "VZ"],
    2021: ["AAPL", "MSFT", "AMZN", "GOOGL", "META", "TSLA", "BRK.B", "V", "JNJ", "WMT", "JPM", "MA", "PG", "NVDA", "UNH", "DIS", "HD", "PYPL", "BAC", "VZ"],
    2022: ["AAPL", "MSFT", "GOOGL", "AMZN", "TSLA", "META", "NVDA", "BRK.B", "UNH", "JPM", "JNJ", "HD", "V", "PG", "BAC", "MA", "PFE", "DIS", "AVGO", "XOM"],
    2023: ["AAPL", "MSFT", "GOOGL", "AMZN", "BRK.B", "UNH", "JNJ", "XOM", "JPM", "V", "NVDA", "WMT", "TSLA", "PG", "LLY", "MA", "HD", "CVX", "META", "ABBV"],
    2024: ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "BRK.B", "LLY", "AVGO", "V", "JPM", "UNH", "WMT", "MA", "XOM", "JNJ", "HD", "PG", "COST"],
    2025: ["AAPL", "NVDA", "MSFT", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "BRK.B", "WMT", "LLY", "JPM", "V", "MA", "XOM", "ORCL", "UNH", "COST", "NFLX", "HD"],
  },
  nse: {
    2016: ["TCS", "RELIANCE", "HDFCBANK", "ITC", "INFY", "HDFC", "ONGC", "SBIN", "HINDUNILVR", "ICICIBANK", "SUNPHARMA", "COALINDIA", "LT", "BHARTIARTL", "WIPRO", "KOTAKBANK", "HCLTECH", "AXISBANK", "MARUTI", "NTPC"],
    2017: ["TCS", "RELIANCE", "HDFCBANK", "ITC", "INFY", "HDFC", "HINDUNILVR", "ONGC", "SBIN", "MARUTI", "COALINDIA", "ICICIBANK", "SUNPHARMA", "KOTAKBANK", "LT", "BHARTIARTL", "WIPRO", "HCLTECH", "NTPC", "AXISBANK"],
    2018: ["RELIANCE", "TCS", "HDFCBANK", "ITC", "HDFC", "HINDUNILVR", "MARUTI", "INFY", "KOTAKBANK", "SBIN", "ICICIBANK", "ONGC", "IOC", "BHARTIARTL", "LT", "COALINDIA", "AXISBANK", "WIPRO", "HCLTECH", "BAJFINANCE"],
    2019: ["RELIANCE", "TCS", "HDFCBANK", "HINDUNILVR", "ITC", "INFY", "HDFC", "KOTAKBANK", "ICICIBANK", "SBIN", "MARUTI", "BAJFINANCE", "LT", "AXISBANK", "ONGC", "HCLTECH", "WIPRO", "IOC", "COALINDIA", "BHARTIARTL"],
    2020: ["RELIANCE", "TCS", "HDFCBANK", "HINDUNILVR", "HDFC", "INFY", "KOTAKBANK", "ICICIBANK", "ITC", "SBIN", "BAJFINANCE", "AXISBANK", "BHARTIARTL", "LT", "MARUTI", "HCLTECH", "NESTLEIND", "ASIANPAINT", "ONGC", "WIPRO"],
    2021: ["RELIANCE", "TCS", "HDFCBANK", "INFY", "HINDUNILVR", "HDFC", "ICICIBANK", "KOTAKBANK", "BAJFINANCE", "SBIN", "BHARTIARTL", "WIPRO", "HCLTECH", "ITC", "ASIANPAINT", "MARUTI", "AXISBANK", "LT", "ULTRACEMCO", "NESTLEIND"],
    2022: ["RELIANCE", "TCS", "HDFCBANK", "INFY", "HINDUNILVR", "ICICIBANK", "HDFC", "SBIN", "BAJFINANCE", "BHARTIARTL", "KOTAKBANK", "WIPRO", "HCLTECH", "ITC", "ASIANPAINT", "LT", "AXISBANK", "MARUTI", "BAJAJFINSV", "TITAN"],
    2023: ["RELIANCE", "TCS", "HDFCBANK", "ICICIBANK", "INFY", "HINDUNILVR", "HDFC", "SBIN", "ITC", "BHARTIARTL", "BAJFINANCE", "ADANIENT", "KOTAKBANK", "LT", "HCLTECH", "ASIANPAINT", "AXISBANK", "MARUTI", "TITAN", "SUNPHARMA"],
    2024: ["RELIANCE", "TCS", "HDFCBANK", "ICICIBANK", "INFY", "BHARTIARTL", "SBIN", "HINDUNILVR", "ITC", "LT", "BAJFINANCE", "HCLTECH", "KOTAKBANK", "AXISBANK", "ADANIENT", "MARUTI", "SUNPHARMA", "TITAN", "ONGC", "NTPC"],
    2025: ["RELIANCE", "HDFCBANK", "TCS", "BHARTIARTL", "ICICIBANK", "SBIN", "INFY", "HINDUNILVR", "ITC", "BAJFINANCE", "LT", "HCLTECH", "SUNPHARMA", "KOTAKBANK", "MARUTI", "M&M", "AXISBANK", "NTPC", "ULTRACEMCO", "ONGC"],
  },
};

/** Each market's index fund: its 200-day average guards moving averages and momentum. It isn't traded here. */
export const MARKET_FUND: Record<StockMarket, string> = { us: "SPY", nse: "NIFTYBEES" };

/** The desk's name for a stock ("AAPL.US", "RELIANCE"), and its ticker. */
const symbolOf = (market: StockMarket, ticker: string) => (market === "us" ? `${ticker}.US` : ticker);
const tickerOf = (symbol: string) => symbol.replace(/\.US$/, "");
const marketOf = (symbol: string): StockMarket => (symbol.endsWith(".US") ? "us" : "nse");

/** The list a year trades: its own, after the lists the last one, before them none. */
export function stockCohortFor(market: StockMarket, year: number): string[] {
  const years = Object.keys(STOCK_COHORTS[market]).map(Number).sort((a, b) => a - b);
  if (year < years[0]) return [];
  return STOCK_COHORTS[market][Math.min(years[years.length - 1], year)];
}

/** Whether a trade opened at `ms` on `symbol` counts: the stock was on that year's list. */
export function inStockCohort(symbol: string, ms: number): boolean {
  return stockCohortFor(marketOf(symbol), new Date(ms).getUTCFullYear()).includes(tickerOf(symbol));
}

/** A market's stocks: its fund first, then every stock on any year's list. */
export function stockSymbols(market: StockMarket): string[] {
  const all = [...new Set(Object.values(STOCK_COHORTS[market]).flat())];
  return [MARKET_FUND[market], ...all].map((t) => symbolOf(market, t));
}

/** A round trip's costs on a market's daily trades (share of the trade): fees and a typical spread; India's as delivery. */
export function stockCost(market: StockMarket): number {
  return market === "us"
    ? roundTripFeeRate("SPY.US") + UNREAD_STOCK_SPREAD.us
    : nseDeliveryRoundTripRate(SLOW_NSE_TRADE_INR) + UNREAD_STOCK_SPREAD.nse;
}

/** What a split or bonus issue does to the price: 2-for-1 halves it, 1:2 bonus takes it to two thirds, and so on. */
const SPLIT_FACTORS = [1 / 2, 1 / 3, 2 / 3, 1 / 4, 1 / 5, 1 / 10];

/**
 * Finds splits and bonus issues in unadjusted daily candles (a day that opens
 * and closes at one of SPLIT_FACTORS of the day before) and adjusts the
 * earlier candles to match, as an adjusted source would. Changes `s`; returns
 * how many it found. A large stock almost never really falls by a third or
 * a half overnight and stays there.
 */
export function adjustForSplits(s: CandleSeries): number {
  let found = 0;
  for (let i = 1; i < s.t.length; i++) {
    const gap = s.o[i] / s.c[i - 1];
    const day = s.c[i] / s.c[i - 1];
    const f = SPLIT_FACTORS.find((x) => Math.abs(gap / x - 1) < 0.03 && Math.abs(day / x - 1) < 0.15);
    if (f === undefined) continue;
    for (let j = 0; j < i; j++) {
      s.o[j] *= f;
      s.h[j] *= f;
      s.l[j] *= f;
      s.c[j] *= f;
      s.v[j] /= f;
    }
    found++;
  }
  return found;
}

export interface StockLongMarket {
  status: "done" | "failed" | "skipped";
  candles: number;
  firstMs?: number;
  lastMs?: number;
  note?: string;
  /** Splits and bonus issues found in its candles and adjusted for. */
  adjusted?: number;
}

export interface StocksLongRun {
  version: number;
  classicVersion: number;
  startedAt: number;
  finishedAt: number | null;
  fromMs: number;
  toMs: number;
  markets: Record<string, StockLongMarket>;
  /** The classic strategies' results, each market's by quarter (a market finished in this run, or the last run's). */
  classic: Partial<Record<StockMarket, ClassicRecords>>;
  /** Markets this run has finished. */
  done: StockMarket[];
}

export interface StocksLongDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  download: (symbol: string, fromMs: number, toMs: number) => Promise<HistoryFetch>;
  scannerBusy: () => boolean;
  nseBusy: (now: number) => boolean;
}

const realDeps: StocksLongDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  download: (symbol, fromMs, toMs) => (marketOf(symbol) === "us" ? fetchUsDaily(symbol, fromMs, toMs) : fetchNseDaily(symbol, fromMs, toMs)),
  scannerBusy: () => scannerHeartbeat().cycleRunning,
  nseBusy,
};

const file = () => path.join(process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data"), "stocks_long.json");

let run: StocksLongRun | null = null;
let active: Promise<void> | null = null;
let current: string | null = null;
let waitingForNse = false;
let total = 0;
let generation = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

export function loadStocksLong(): void {
  try {
    if (!fs.existsSync(file())) return;
    const saved = JSON.parse(fs.readFileSync(file(), "utf8")) as StocksLongRun;
    if (saved && typeof saved === "object" && saved.markets && saved.classic) run = saved;
  } catch (err) {
    console.warn("[StocksLong] Couldn't read saved results:", err);
  }
}

function save(): void {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(`${file()}.tmp`, JSON.stringify(run), "utf8");
    fs.renameSync(`${file()}.tmp`, file());
  } catch (err) {
    console.warn("[StocksLong] Couldn't save results:", err);
  }
}

/** Whether the kept results need replaying from the start: none, another version, or a month old. */
export function stocksLongDue(saved: StocksLongRun | null, now: number): boolean {
  if (!saved || saved.version !== STOCKS_LONG_VERSION || saved.classicVersion !== CLASSIC_VERSION) return true;
  return saved.finishedAt !== null && now - saved.finishedAt > RERUN_AFTER_MS;
}

async function work(gen: number, fresh: boolean, deps: StocksLongDeps): Promise<void> {
  const stopped = () => gen !== generation;
  if (fresh || !run) {
    run = {
      version: STOCKS_LONG_VERSION,
      classicVersion: CLASSIC_VERSION,
      startedAt: deps.now(),
      finishedAt: null,
      fromMs: STOCKS_FROM_MS,
      toMs: Math.floor(deps.now() / DAY_MS) * DAY_MS,
      markets: {},
      // The last run's results stay on show until this run replaces each market's.
      classic: run?.classic ?? {},
      done: [],
    };
    save();
  }
  const r = run;
  total = STOCK_MARKETS.reduce((n, m) => n + stockSymbols(m).length, 0);
  const rest = async (took: number) => {
    await deps.sleep(Math.max(1, Math.round(took * (1 / CPU_SHARE - 1))));
    while (deps.scannerBusy()) await deps.sleep(CYCLE_WAIT_MS);
  };

  /** Downloads one stock into `into`; false if the run was stopped. */
  const fetchStock = async (symbol: string, into: Record<string, CandleSeries>): Promise<boolean> => {
    current = symbol;
    while (marketOf(symbol) === "nse" && deps.nseBusy(deps.now())) {
      waitingForNse = true;
      await deps.sleep(NSE_WAIT_MS);
      if (stopped()) return false;
    }
    waitingForNse = false;
    const got = await deps.download(symbol, r.fromMs, r.toMs);
    await deps.sleep(PAUSE_MS);
    if (stopped()) return false;
    if ("error" in got) {
      r.markets[symbol] = { status: "failed", candles: 0, note: got.error };
    } else {
      const s = got.series;
      const adjusted = marketOf(symbol) === "nse" ? adjustForSplits(s) : 0;
      const n = s.t.length;
      const enough = n >= MIN_DAYS;
      r.markets[symbol] = {
        status: enough ? "done" : "skipped",
        candles: n,
        firstMs: s.t[0],
        lastMs: s.t[n - 1],
        ...(adjusted > 0 ? { adjusted } : {}),
        ...(enough ? {} : { note: `Only ${n} days of candles` }),
      };
      if (enough) into[symbol] = s;
    }
    save();
    return true;
  };

  for (const market of STOCK_MARKETS) {
    if (r.done.includes(market)) continue;
    const symbols = stockSymbols(market);
    const series: Record<string, CandleSeries> = {};
    for (const symbol of symbols) {
      if (stopped() || !(await fetchStock(symbol, series))) return;
    }
    // A stock that failed (the source busy, say) gets one more try.
    const failed = symbols.filter((s) => r.markets[s]?.status === "failed");
    if (failed.length > 0) {
      await deps.sleep(RETRY_AFTER_MS);
      for (const symbol of failed) {
        if (stopped() || !(await fetchStock(symbol, series))) return;
      }
    }
    current = null;

    const fund = symbolOf(market, MARKET_FUND[market]);
    const up = series[fund] ? uptrend(series[fund]) : () => undefined;
    // US breakout trades with their readings at entry, for the machine-learning test on breakout trades.
    const fundMarket = series[fund] ? marketCandles(series[fund]) : undefined;
    const setups: BreakoutSetup[] = [];
    const cost = stockCost(market);
    const stocks = Object.fromEntries(Object.entries(series).filter(([symbol]) => symbol !== fund));
    const classic: ClassicRecords = {};
    for (const [symbol, s] of Object.entries(stocks)) {
      const started = deps.now();
      const eligible = (ms: number) => inStockCohort(symbol, ms);
      const breakouts = breakoutTrades(symbol, s, cost, eligible);
      addClassicTrades(classic, breakouts);
      if (market === "us") setups.push(...breakoutSetups(s, breakouts, fundMarket));
      addClassicTrades(classic, maTrendTrades(symbol, s, up, cost, eligible));
      await rest(deps.now() - started);
      if (stopped()) return;
    }
    const started = deps.now();
    addClassicTrades(classic, momentumTrades(stocks, up, () => cost, inStockCohort, stockWeekClose));
    await rest(deps.now() - started);
    if (stopped()) return;
    r.classic[market] = classic;
    r.done.push(market);
    if (market === "us") saveBreakoutSetups("us", setups, deps.now());
    save();
  }
  r.finishedAt = deps.now();
  save();
  console.log(`[StocksLong] Replayed the classic strategies on ${Object.values(r.markets).filter((m) => m.status === "done").length} stocks' daily candles since 2016.`);
}

/** Starts a run unless one is going: from the start when `fresh` or due, otherwise carrying on with the kept one. */
export function startStocksLong(fresh: boolean, deps: StocksLongDeps = realDeps): Promise<void> {
  if (active && !fresh) return active;
  const gen = ++generation;
  const job = work(gen, fresh || stocksLongDue(run, deps.now()), deps)
    .catch((err) => console.error("[StocksLong] Run failed:", err))
    .finally(() => {
      if (gen !== generation) return;
      active = null;
      current = null;
      waitingForNse = false;
    });
  active = job;
  return job;
}

/** Loads kept results, then checks every few hours whether a run is due, never alongside the other background work. */
export function startStocksLongJob(): void {
  loadStocksLong();
  waitForOtherWork(() => active !== null);
  const check = () => {
    timer = setTimeout(check, CHECK_EVERY_MS);
    const due = stocksLongDue(run, Date.now()) || (run !== null && run.finishedAt === null);
    if (!active && !historyRunning() && !backgroundWorkBusy() && due) void startStocksLong(false);
  };
  timer = setTimeout(check, START_DELAY_MS);
}

/** What the Lab shows: progress, each market's results so far, and each year's stocks. */
export function stocksLongView() {
  const markets = run?.markets ?? {};
  return {
    running: active !== null,
    current,
    waitingForNse,
    finished: Object.keys(markets).length,
    total: active ? total : Object.keys(markets).length,
    run: run
      ? {
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          fromMs: run.fromMs,
          toMs: run.toMs,
          done: run.done,
          problems: Object.entries(markets)
            .filter(([, m]) => m.status !== "done")
            .map(([symbol, m]) => ({ symbol, note: m.note ?? m.status })),
          adjusted: Object.entries(markets).flatMap(([symbol, m]) => (m.adjusted ? [{ symbol, count: m.adjusted }] : [])),
        }
      : null,
    /** Each market's classic results by quarter (absent until it has run). */
    classic: run?.classic ?? {},
    cohorts: STOCK_COHORTS,
    funds: MARKET_FUND,
  };
}

/** A run is going (the machine-learning test on breakout trades waits for it). */
export const stocksLongRunning = (): boolean => active !== null;

/** A market's classic results by quarter (the last finished run's while it reruns), or null before any: US breakout and momentum trades are judged on them. */
export function stocksLongClassic(market: StockMarket): ClassicRecords | null {
  return run?.classic[market] ?? null;
}

/** Test hooks. */
export function _resetStocksLong(): void {
  generation++;
  run = null;
  active = null;
  current = null;
  waitingForNse = false;
  total = 0;
  if (timer) clearTimeout(timer);
  timer = null;
}
export function _stocksLongRun(): StocksLongRun | null {
  return run;
}
