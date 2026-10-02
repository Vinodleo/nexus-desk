import fs from "fs";
import path from "path";
import { promisify } from "util";
import { gunzip, gzip } from "zlib";
import { getCoinUniverse } from "../coinUniverse";
import { fetchCoinHistory, fetchNseHistory, fetchUsHistory, type HistoryFetch } from "./historyCandles";
import { scannerHeartbeat, stockUniverse, typicalSpread, usUniverse } from "../scanner/scannerService";
import {
  addToRecords,
  aggregateSeries,
  FIXED_COINS,
  hourOffsetMs,
  lastHourMove,
  marketTotals,
  replayHistory,
  replayTimeframe,
  setupCsvHeader,
  setupCsvRow,
  timeframeSeries,
  TIMEFRAMES,
  type CandleSeries,
  type HistoryRecords,
  type HistoryTrade,
  type MarketTotals,
  type Timeframe,
} from "../../src/services/historyReplay";
import { TRADER_PERSONAS } from "../../src/services/personaEngine";
import { TRAIL_PROFILES, type TrailProfileId } from "../../src/shared/trailingStop";
import { MAX_COIN_SPREAD, roundTripFeeRate } from "../../src/shared/tradeCosts";
import { isNseOpen, isNseSymbol, nseDeliveryRoundTripRate } from "../../src/shared/nse";
import { isUsSymbol } from "../../src/shared/usMarket";

// The traders over the last two years: each market's 5-minute candles are
// downloaded and replayed (src/services/historyReplay.ts) in the background,
// one market at a time. The 5-minute candles aren't kept, only the results
// (on the volume, so a restart carries on from the next market), every
// setup found, with its readings and results (history_setups/, a compressed
// CSV file per market: the data machine learning trains on), and the
// market's hourly candles (history_candles_1h/), for slower strategies to
// be tried on without downloading again. Each market is also replayed on
// 1-hour and 1-day candles (slower trades, held for days). It runs a while
// after the server starts, then again weekly, or when the traders change.
//
// The server shares a CPU that only guarantees a small slice of a core
// (Fly's shared CPU: 6.25%, with a short burst allowance). Using more for
// long drains the allowance and slows everything, the live scanner
// included, so the replay works in short bursts and rests in between, using
// about CPU_SHARE of a core, and waits while a scan cycle runs. Indian
// stocks are downloaded only while NSE is closed: Angel One's limits are
// shared with the live scanner's requests.

export const HISTORY_DAYS = 730;
/** Bump when the replay changes enough that old results no longer compare. */
export const HISTORY_VERSION = 4;
/**
 * Bump when only the slower (1-hour, 1-day) replay changes: replayed
 * markets redo it from their kept hourly candles, without downloading again.
 */
export const SLOW_VERSION = 4;
/** Results this old are replayed again. */
export const RERUN_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** Share of a core the replay uses on average. */
export const CPU_SHARE = 0.03;
/** The first check after the server starts (it's busy loading candles until then). */
const START_DELAY_MS = 10 * 60 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** How often a wait (for NSE to close, or a scan cycle to end) checks again. */
const NSE_WAIT_MS = 5 * 60 * 1000;
const CYCLE_WAIT_MS = 500;
/** A market with fewer candles than this (about two weeks of stock sessions) isn't replayed. */
const MIN_CANDLES = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PROFILES = Object.keys(TRAIL_PROFILES) as TrailProfileId[];

const dataDir = () => process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data");
const file = () => path.join(dataDir(), "history_results.json");
/** Each market's setups, one compressed CSV file each. */
export const setupsDir = () => path.join(dataDir(), "history_setups");
/** A market's setups file name, e.g. "BTC_INR.csv.gz". */
export const setupsFileName = (symbol: string) => `${symbol.replace(/[^A-Za-z0-9]+/g, "_")}.csv.gz`;
const setupsFile = (symbol: string) => path.join(setupsDir(), setupsFileName(symbol));
/**
 * The setup files stop growing past this, so they can never fill the volume
 * (1 GB, shared with everything else the server keeps). Two years of every
 * market should take well under it.
 */
export const MAX_SETUP_BYTES = 300 * 1024 * 1024;
/** The markets whose last hour each saved setup records: Bitcoin for coins, SPY for US stocks. */
const LEADERS = { crypto: "BTC/INR", us: "SPY.US" } as const;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
/** Each market's hourly candles, a compressed CSV file each ("t,o,h,l,c,v"). */
export const hourlyDir = () => path.join(dataDir(), "history_candles_1h");
/**
 * What a slower Indian trade is charged: held overnight it's a delivery
 * trade, costed at the amount per trade the desk uses (₹25,000; a ₹20
 * depository charge weighs more on smaller ones).
 */
export const SLOW_NSE_TRADE_INR = 25_000;

export interface HistoryMarket {
  status: "done" | "failed" | "skipped";
  candles: number;
  /** The first and last candle replayed (ms). */
  firstMs?: number;
  lastMs?: number;
  /** Why it failed or was skipped. */
  note?: string;
  /** Setups saved for it, and the size of its file (bytes). */
  setups?: number;
  setupBytes?: number;
  /** Its slower trades are in the run's slower results (false: to redo from its hourly candles). */
  slowIncluded?: boolean;
  /** Its own slower results, every trader together (the coin check compares markets). */
  slowTotals?: MarketTotals;
}

export interface HistoryRun {
  version: number;
  /** The slower replay's version (SLOW_VERSION) its slower results come from. */
  slowVersion?: number;
  startedAt: number;
  finishedAt: number | null;
  /** The period downloaded (ms). */
  fromMs: number;
  toMs: number;
  /** The traders (persona ids) it was replayed with. */
  traders: string[];
  /** Each market finished so far, by symbol. */
  markets: Record<string, HistoryMarket>;
  records: HistoryRecords;
  /** The same on slower candles (1-hour, 1-day). */
  slow?: Partial<Record<Timeframe, HistoryRecords>>;
}

export type HistoryPhase = "idle" | "starting" | "downloading" | "replaying" | "waiting_for_nse";

/** Everything the job reaches outside itself, so tests can stand in for it. */
export interface HistoryDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The markets to replay, in order: coins, then US stocks, then Indian ones. */
  symbols: () => Promise<string[]>;
  download: (symbol: string, fromMs: number, toMs: number) => Promise<HistoryFetch>;
  spread: (symbol: string) => number | undefined;
  /** A scan cycle is running: the replay waits for it. */
  scannerBusy: () => boolean;
}

const realDeps: HistoryDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  symbols: async () => marketsToReplay((await getCoinUniverse()).coins.map((c) => c.symbol), usUniverse(), stockUniverse()),
  download: (symbol, fromMs, toMs) =>
    isUsSymbol(symbol) ? fetchUsHistory(symbol, fromMs, toMs) : isNseSymbol(symbol) ? fetchNseHistory(symbol, fromMs, toMs) : fetchCoinHistory(symbol, fromMs, toMs),
  spread: typicalSpread,
  scannerBusy: () => scannerHeartbeat().cycleRunning,
};

function leaderFirst(symbols: string[], leader: string): string[] {
  return symbols.includes(leader) ? [leader, ...symbols.filter((s) => s !== leader)] : symbols;
}

/**
 * The markets a run replays, in order: today's most active coins and the
 * coin check's fixed list, then US stocks, then Indian ones. Bitcoin and SPY
 * come first: the other coins' and US stocks' setups record their last hour.
 */
export function marketsToReplay(coins: string[], us: string[], nse: string[]): string[] {
  return [...leaderFirst([...new Set([...coins, ...FIXED_COINS])], LEADERS.crypto), ...leaderFirst(us, LEADERS.us), ...nse];
}

let run: HistoryRun | null = null;
/** Bitcoin's and SPY's candles from this run, for the last-hour reading (gone after a restart: then left blank). */
const leaderSeries = new Map<string, CandleSeries>();
let phase: HistoryPhase = "idle";
let current: string | null = null;
let total = 0;
/** Bumped to stop a run in progress (a new one replaces it). */
let generation = 0;
let active: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

const traderIds = () => TRADER_PERSONAS.map((p) => p.id);

export function loadHistory(): void {
  try {
    if (!fs.existsSync(file())) return;
    const saved = JSON.parse(fs.readFileSync(file(), "utf8")) as HistoryRun;
    if (saved && typeof saved === "object" && saved.markets && saved.records) run = saved;
  } catch (err) {
    console.warn("[History] Couldn't read saved results:", err);
  }
}

function saveHistory(): void {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(`${file()}.tmp`, JSON.stringify(run), "utf8");
    fs.renameSync(`${file()}.tmp`, file());
  } catch (err) {
    console.warn("[History] Couldn't save results:", err);
  }
}

/** Whether the kept results need replaying: none, too old, from another version, or other traders. */
export function needsRun(saved: HistoryRun | null, now: number): boolean {
  if (!saved || saved.version !== HISTORY_VERSION) return true;
  if (saved.traders.join() !== traderIds().join()) return true;
  return now - (saved.finishedAt ?? saved.startedAt) > RERUN_AFTER_MS;
}

/**
 * A stock's spread before any has been read (the server reads US stocks only
 * while New York is open): about what the free IEX feed quotes a large US
 * stock, wider than the whole market's, and a tick or two on a Nifty 50 one.
 */
export const UNREAD_STOCK_SPREAD = { us: 0.0003, nse: 0.0002 };

/**
 * The spread a market's replayed trades pay. Today's spread doesn't decide
 * whether a coin's two years are replayed: the desk doesn't trade a coin
 * while its spread is wider than MAX_COIN_SPREAD, so its trades pay at most
 * that, and that's what it's charged when wider or not read yet (a server
 * just restarted has read few). Stocks pay theirs, as live, or the estimate
 * above, never nothing.
 */
export function historySpread(symbol: string, read: number | undefined): number {
  if (isUsSymbol(symbol)) return read ?? UNREAD_STOCK_SPREAD.us;
  if (isNseSymbol(symbol)) return read ?? UNREAD_STOCK_SPREAD.nse;
  return Math.min(read ?? MAX_COIN_SPREAD, MAX_COIN_SPREAD);
}

/** Whether a kept run's slower results are from an older slower replay (redone from the hourly candles). */
export function slowRedoDue(saved: HistoryRun | null): boolean {
  return !!saved && (saved.slowVersion !== SLOW_VERSION || Object.values(saved.markets).some((m) => m.status === "done" && m.slowIncluded === false));
}

/** A market's kept hourly candles, or null without them. */
async function readHourly(symbol: string): Promise<CandleSeries | null> {
  const target = path.join(hourlyDir(), setupsFileName(symbol));
  if (!fs.existsSync(target)) return null;
  try {
    const text = (await gunzipAsync(fs.readFileSync(target))).toString();
    const out: CandleSeries = { t: [], o: [], h: [], l: [], c: [], v: [] };
    for (const line of text.split("\n").slice(1)) {
      const [t, o, h, l, c, v] = line.split(",").map(Number);
      if (!Number.isFinite(t) || !(c > 0)) continue;
      out.t.push(t);
      out.o.push(o);
      out.h.push(h);
      out.l.push(l);
      out.c.push(c);
      out.v.push(v);
    }
    return out;
  } catch (err) {
    console.warn(`[History] Couldn't read ${symbol}'s hourly candles:`, err);
    return null;
  }
}

/** NSE is open, or within 15 minutes of it (the scanner's last fetch comes just after the close). */
const nseBusy = (now: number) => isNseOpen(now) || isNseOpen(now - 15 * 60_000) || isNseOpen(now + 15 * 60_000);

/** A source asking to slow down: the same market is tried again after a pause. */
const SLOW_DOWN = /slow down|rate limit|too many|429/i;
const SLOW_DOWN_WAIT_MS = 2 * 60 * 1000;
/** Failed markets are tried once more at the end of a run, after this pause. */
const RETRY_FAILED_AFTER_MS = 15 * 60 * 1000;

async function work(gen: number, fresh: boolean, deps: HistoryDeps): Promise<void> {
  const stopped = () => gen !== generation;
  phase = "starting";
  if (fresh || !run) {
    fs.rmSync(setupsDir(), { recursive: true, force: true });
    fs.rmSync(hourlyDir(), { recursive: true, force: true });
    leaderSeries.clear();
    const toMs = Math.floor(deps.now() / DAY_MS) * DAY_MS;
    run = { version: HISTORY_VERSION, slowVersion: SLOW_VERSION, startedAt: deps.now(), finishedAt: null, fromMs: toMs - HISTORY_DAYS * DAY_MS, toMs, traders: traderIds(), markets: {}, records: {}, slow: {} };
    saveHistory();
  }
  const r = run;
  // A changed slower replay starts its results again; replayed markets get it from their kept hourly candles.
  if (r.slowVersion !== SLOW_VERSION) {
    r.slow = {};
    r.slowVersion = SLOW_VERSION;
    for (const m of Object.values(r.markets)) m.slowIncluded = false;
    saveHistory();
  }
  /** Whether this run replays any market from its candles (a run that only redoes slower trades keeps its finish time). */
  let replayedAny = false;
  const symbols = await deps.symbols();
  // The markets this run covers: today's, and any kept from an earlier list (the coins are picked hourly by activity).
  total = new Set([...symbols, ...Object.keys(r.markets)]).size;

  /** Downloads and replays one market into the run; false if the run was stopped. */
  const replayMarket = async (symbol: string): Promise<boolean> => {
    current = symbol;
    while (isNseSymbol(symbol) && nseBusy(deps.now())) {
      phase = "waiting_for_nse";
      await deps.sleep(NSE_WAIT_MS);
      if (stopped()) return false;
    }
    phase = "downloading";
    let fetched = await deps.download(symbol, r.fromMs, r.toMs);
    for (let tries = 1; "error" in fetched && SLOW_DOWN.test(fetched.error) && tries < 3; tries++) {
      await deps.sleep(SLOW_DOWN_WAIT_MS);
      if (stopped()) return false;
      fetched = await deps.download(symbol, r.fromMs, r.toMs);
    }
    if (stopped()) return false;
    if ("error" in fetched) {
      r.markets[symbol] = { status: "failed", candles: 0, note: fetched.error };
      saveHistory();
      return true;
    }
    const { series } = fetched;
    const spread = historySpread(symbol, deps.spread(symbol));
    const skip = series.t.length < MIN_CANDLES ? `Only ${series.t.length} candles` : null;
    const market: HistoryMarket = { status: skip ? "skipped" : "done", candles: series.t.length, firstMs: series.t[0], lastMs: series.t[series.t.length - 1] };
    if (skip) {
      r.markets[symbol] = { ...market, note: skip };
      saveHistory();
      return true;
    }
    phase = "replaying";
    // Bitcoin's and SPY's closes are kept for the other markets' last-hour reading.
    if (symbol === LEADERS.crypto || symbol === LEADERS.us) leaderSeries.set(symbol, { ...series, o: [], h: [], l: [], v: [] });
    const leader = leaderSeries.get(isUsSymbol(symbol) ? LEADERS.us : isNseSymbol(symbol) ? "" : LEADERS.crypto);
    // This market's results join the others only once it's done, so a stop part-way leaves none of it.
    const records: HistoryRecords = {};
    const rows: string[] = [];
    const replay = replayHistory(symbol, series, PROFILES, spread, leader ? lastHourMove(leader) : undefined);
    for (;;) {
      const started = deps.now();
      const step = replay.next();
      const took = deps.now() - started;
      if (step.done) break;
      addToRecords(records, symbol, step.value.trades);
      for (const setup of step.value.setups) rows.push(setupCsvRow(setup, PROFILES));
      // Rest so the replay averages CPU_SHARE of a core, and let a scan cycle finish first.
      await deps.sleep(Math.max(1, Math.round(took * (1 / CPU_SHARE - 1))));
      while (deps.scannerBusy()) await deps.sleep(CYCLE_WAIT_MS);
      if (stopped()) return false;
    }
    const saved = await saveSetups(r, symbol, rows, stopped);
    if (stopped()) return false;
    // Slower trades: the hourly candles (kept), and 1-hour and 1-day replays.
    const hourly = aggregateSeries(series, 60 * 60 * 1000, hourOffsetMs(symbol));
    await saveHourly(symbol, hourly, stopped);
    const slowRecords = await replaySlow(symbol, hourly, spread);
    if (!slowRecords) return false;
    mergeRecords(r.records, records);
    for (const tf of TIMEFRAMES) mergeRecords(((r.slow ??= {})[tf] ??= {}), slowRecords[tf] ?? {});
    r.markets[symbol] = { ...market, ...saved, slowIncluded: true, slowTotals: marketTotals(slowRecords) };
    replayedAny = true;
    saveHistory();
    return true;
  };

  /** The 1-hour and 1-day replays of a market's hourly candles; null if the run was stopped. */
  async function replaySlow(symbol: string, hourly: CandleSeries, spread: number): Promise<Partial<Record<Timeframe, HistoryRecords>> | null> {
    const slowFee = isNseSymbol(symbol) ? nseDeliveryRoundTripRate(SLOW_NSE_TRADE_INR) : roundTripFeeRate(symbol);
    const slowRecords: Partial<Record<Timeframe, HistoryRecords>> = {};
    for (const tf of TIMEFRAMES) {
      const tfRecords: HistoryRecords = {};
      const slowReplay = replayTimeframe(symbol, timeframeSeries(hourly, tf), tf, PROFILES, slowFee, spread);
      for (;;) {
        const started = deps.now();
        const step: IteratorResult<HistoryTrade[]> = slowReplay.next();
        const took = deps.now() - started;
        if (step.done) break;
        addToRecords(tfRecords, symbol, step.value);
        await deps.sleep(Math.max(1, Math.round(took * (1 / CPU_SHARE - 1))));
        while (deps.scannerBusy()) await deps.sleep(CYCLE_WAIT_MS);
        if (stopped()) return null;
      }
      slowRecords[tf] = tfRecords;
    }
    return slowRecords;
  }

  /** A replayed market's slower trades again, from its kept hourly candles (after the slower replay changed). */
  const redoSlow = async (symbol: string): Promise<boolean> => {
    current = symbol;
    phase = "replaying";
    const hourly = await readHourly(symbol);
    let slowTotals: MarketTotals | undefined;
    if (hourly) {
      const slowRecords = await replaySlow(symbol, hourly, historySpread(symbol, deps.spread(symbol)));
      if (!slowRecords) return false;
      for (const tf of TIMEFRAMES) mergeRecords(((r.slow ??= {})[tf] ??= {}), slowRecords[tf] ?? {});
      slowTotals = marketTotals(slowRecords);
    }
    r.markets[symbol] = { ...r.markets[symbol], slowIncluded: true, slowTotals };
    saveHistory();
    return true;
  };

  // Markets already replayed whose slower trades are from an older slower replay: again, from their hourly candles.
  for (const [symbol, m] of Object.entries(r.markets)) {
    if (stopped()) return;
    if (m.status === "done" && m.slowIncluded === false && !(await redoSlow(symbol))) return;
  }
  for (const symbol of symbols) {
    if (stopped()) return;
    if (!r.markets[symbol] && !(await replayMarket(symbol))) return;
  }
  const failed = symbols.filter((s) => r.markets[s]?.status === "failed");
  if (failed.length > 0) {
    await deps.sleep(RETRY_FAILED_AFTER_MS);
    for (const symbol of failed) {
      if (stopped()) return;
      delete r.markets[symbol];
      if (!(await replayMarket(symbol))) return;
    }
  }
  if (replayedAny || r.finishedAt === null) r.finishedAt = deps.now();
  saveHistory();
  console.log(`[History] Replayed ${Object.values(r.markets).filter((m) => m.status === "done").length} of ${symbols.length} markets over ${HISTORY_DAYS} days.`);
}

/** Writes a market's hourly candles (compressed CSV), for slower strategies to be tried on later. */
async function saveHourly(symbol: string, hourly: CandleSeries, stopped: () => boolean): Promise<void> {
  try {
    const lines = hourly.t.map((t, k) => `${t},${hourly.o[k]},${hourly.h[k]},${hourly.l[k]},${hourly.c[k]},${hourly.v[k]}`);
    const data = await gzipAsync(Buffer.from(`t,o,h,l,c,v\n${lines.join("\n")}\n`));
    if (stopped()) return;
    fs.mkdirSync(hourlyDir(), { recursive: true });
    const target = path.join(hourlyDir(), setupsFileName(symbol));
    fs.writeFileSync(`${target}.tmp`, data);
    fs.renameSync(`${target}.tmp`, target);
  } catch (err) {
    console.warn(`[History] Couldn't save ${symbol}'s hourly candles:`, err);
  }
}

/** Bytes the run's setup files take so far. */
const setupBytesOf = (r: HistoryRun) => Object.values(r.markets).reduce((n, m) => n + (m.setupBytes ?? 0), 0);

/** Writes a market's setups (compressed CSV), unless the files have reached MAX_SETUP_BYTES. */
async function saveSetups(r: HistoryRun, symbol: string, rows: string[], stopped: () => boolean): Promise<{ setups: number; setupBytes: number }> {
  if (rows.length === 0 || setupBytesOf(r) >= MAX_SETUP_BYTES) return { setups: 0, setupBytes: 0 };
  try {
    // Compressed off the main thread; a run replaced meanwhile doesn't write into the new one's files.
    const data = await gzipAsync(Buffer.from(`${setupCsvHeader(PROFILES)}\n${rows.join("\n")}\n`));
    if (stopped()) return { setups: 0, setupBytes: 0 };
    fs.mkdirSync(setupsDir(), { recursive: true });
    fs.writeFileSync(`${setupsFile(symbol)}.tmp`, data);
    fs.renameSync(`${setupsFile(symbol)}.tmp`, setupsFile(symbol));
    return { setups: rows.length, setupBytes: data.length };
  } catch (err) {
    console.warn(`[History] Couldn't save ${symbol}'s setups:`, err);
    return { setups: 0, setupBytes: 0 };
  }
}

function mergeRecords(into: HistoryRecords, add: HistoryRecords): void {
  for (const [profile, byPeriod] of Object.entries(add) as [TrailProfileId, Record<string, Record<string, any>>][]) {
    const intoProfile = (into[profile] ??= {});
    for (const [period, byKey] of Object.entries(byPeriod)) {
      const intoPeriod = (intoProfile[period] ??= {});
      for (const [key, rec] of Object.entries(byKey)) {
        const held = intoPeriod[key];
        intoPeriod[key] = held
          ? { trades: held.trades + rec.trades, totalR: held.totalR + rec.totalR, wins: held.wins + rec.wins, winR: held.winR + rec.winR, lossR: held.lossR + rec.lossR }
          : { ...rec };
      }
    }
  }
}

/**
 * Starts a run unless one is going: a fresh one (`fresh`, or when the kept
 * results need replaying), otherwise it carries on with the kept one.
 */
export function startHistoryRun(fresh: boolean, deps: HistoryDeps = realDeps): Promise<void> {
  if (active && !fresh) return active;
  const gen = ++generation;
  const fromScratch = fresh || needsRun(run, deps.now());
  const job = work(gen, fromScratch, deps)
    .catch((err) => console.error("[History] Run failed:", err))
    .finally(() => {
      if (gen !== generation) return;
      active = null;
      phase = "idle";
      current = null;
    });
  active = job;
  return job;
}

/** Other background work that a scheduled replay waits for (the machine-learning test): both at once would double the load. */
let otherWorkBusy: () => boolean = () => false;
export function waitForOtherWork(busy: () => boolean): void {
  otherWorkBusy = busy;
}

/** Loads kept results and checks a while after start, then every few hours, whether a run is due. */
export function startHistoryJob(): void {
  loadHistory();
  const check = () => {
    timer = setTimeout(check, CHECK_EVERY_MS);
    if (!active && !otherWorkBusy() && (needsRun(run, Date.now()) || (run && run.finishedAt === null) || slowRedoDue(run))) void startHistoryRun(false);
  };
  timer = setTimeout(check, START_DELAY_MS);
}

/** What the app shows: progress, and the results so far. */
export function historyView() {
  const markets = run?.markets ?? {};
  const kinds = { crypto: (s: string) => !isUsSymbol(s) && !isNseSymbol(s), us: isUsSymbol, nse: isNseSymbol };
  const byMarket = Object.fromEntries(
    Object.entries(kinds).map(([kind, is]) => {
      const list = Object.entries(markets).filter(([s]) => is(s));
      return [kind, { done: list.filter(([, m]) => m.status === "done").length, failed: list.filter(([, m]) => m.status === "failed").length, skipped: list.filter(([, m]) => m.status === "skipped").length }];
    })
  );
  return {
    running: active !== null,
    phase,
    current,
    finished: Object.keys(markets).length,
    total: active ? total : Object.keys(markets).length,
    run: run
      ? {
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          fromMs: run.fromMs,
          toMs: run.toMs,
          markets: byMarket,
          setups: {
            count: Object.values(markets).reduce((n, m) => n + (m.setups ?? 0), 0),
            bytes: setupBytesOf(run),
            full: setupBytesOf(run) >= MAX_SETUP_BYTES,
          },
          problems: Object.entries(markets)
            .filter(([, m]) => m.status !== "done")
            .slice(0, 12)
            .map(([symbol, m]) => ({ symbol, note: m.note ?? m.status })),
        }
      : null,
    records: run?.records ?? {},
    slow: run?.slow ?? {},
    /** Each market's own slower results (the coin check). */
    slowByMarket: Object.fromEntries(Object.entries(markets).flatMap(([symbol, m]) => (m.status === "done" && m.slowTotals ? [[symbol, m.slowTotals]] : []))) as Record<string, MarketTotals>,
  };
}

/** Test hooks. */
export function _resetHistoryJob(): void {
  generation++;
  leaderSeries.clear();
  run = null;
  phase = "idle";
  current = null;
  total = 0;
  active = null;
  if (timer) clearTimeout(timer);
  timer = null;
}

/** The kept run (finished or not), for the machine-learning test. */
export function historyRunInfo(): HistoryRun | null {
  return run;
}

/** A replay is under way (the machine-learning test waits for it). */
export function historyRunning(): boolean {
  return active !== null;
}

export function _historyRun(): HistoryRun | null {
  return run;
}
