import fs from "fs";
import path from "path";
import { promisify } from "util";
import { gunzip, gzip } from "zlib";
import {
  addToRecords,
  pastMove,
  replayTimeframe,
  setupCsvHeader,
  setupCsvRow,
  totalsByProfile,
  type CandleSeries,
  type HistoryRecords,
  type HistoryTrade,
  TIMEFRAME_RULES,
} from "../../src/services/historyReplay";
import type { TraderRecord } from "../../src/services/exitExpectancy";
import { TRADER_PERSONAS } from "../../src/services/personaEngine";
import { TRAIL_PROFILES, type TrailProfileId } from "../../src/shared/trailingStop";
import { roundTripFeeRate } from "../../src/shared/tradeCosts";
import { addClassicTrades, breakoutTrades, btcUptrend, maTrendTrades, momentumTrades, type ClassicRecords } from "../../src/services/classicStrategies";
import { fetchCoinDailySince, type HistoryFetch } from "./historyCandles";
import { backgroundWorkBusy, CPU_SHARE, historyRunning, historySpread, setupsFileName, waitForOtherWork } from "./historyJob";
import { scannerHeartbeat, typicalSpread } from "../scanner/scannerService";

// Coins on daily candles over every year Binance has, back to 2017. The
// two-year replay found the traders making money on daily coin candles, but
// two years is one market: this asks whether it lasts through long falling
// ones (2018, 2022) too. The same traders, trailing stops, 30-day holds,
// fees and spreads as the two-year replay's daily trades.
//
// Picking today's big coins and replaying them back to 2017 would flatter
// the traders: those are the coins that survived and grew. So each year
// trades only that year's 20 biggest coins on 1 January (COIN_COHORTS),
// known then, and coins Binance has since delisted are read from its
// archive. A coin is replayed over all its candles (so its indicators have
// warmed up), and a trade counts if it opened in a year the coin was on
// that year's list.
//
// It runs in the background like the two-year replay, at CPU_SHARE of a
// core, never alongside it or the machine-learning test, and again monthly.

/** Bump when the replay changes enough that old results no longer compare. */
export const DAILY_LONG_VERSION = 2;
/**
 * Bump when only the classic strategies change (src/services/
 * classicStrategies.ts): they're replayed again from the kept daily candles,
 * leaving the traders' results (and the daily trades they decide) as they are.
 */
export const CLASSIC_VERSION = 1;
/** From Binance's first candles (August 2017). */
export const DAILY_LONG_FROM_MS = Date.UTC(2017, 7, 1);
const RERUN_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const START_DELAY_MS = 20 * 60 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const CYCLE_WAIT_MS = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const PROFILES = Object.keys(TRAIL_PROFILES) as TrailProfileId[];

/**
 * The 20 biggest coins by market value on 1 January each year (stablecoins
 * left out), from memory of the rankings of the time: picked by size then,
 * not by how they did after. Later years use the last list.
 */
export const COIN_COHORTS: Record<number, string[]> = {
  2018: ["BTC", "XRP", "ETH", "BCH", "ADA", "LTC", "XEM", "XLM", "IOTA", "DASH", "NEO", "TRX", "XMR", "EOS", "ETC", "QTUM", "BTG", "ICX", "LSK", "NANO"],
  2019: ["BTC", "XRP", "ETH", "BCH", "EOS", "XLM", "LTC", "TRX", "BSV", "ADA", "IOTA", "BNB", "XMR", "DASH", "XEM", "ETC", "NEO", "MKR", "ZEC", "WAVES"],
  2020: ["BTC", "ETH", "XRP", "BCH", "LTC", "BSV", "EOS", "BNB", "XTZ", "XLM", "LINK", "ADA", "XMR", "TRX", "ETC", "DASH", "NEO", "ATOM", "IOTA", "XEM"],
  2021: ["BTC", "ETH", "XRP", "LTC", "BCH", "LINK", "ADA", "DOT", "BNB", "XLM", "BSV", "EOS", "XMR", "TRX", "XEM", "XTZ", "THETA", "VET", "ATOM", "UNI"],
  2022: ["BTC", "ETH", "BNB", "SOL", "ADA", "XRP", "LUNA", "DOT", "AVAX", "DOGE", "SHIB", "MATIC", "LTC", "LINK", "UNI", "NEAR", "ALGO", "TRX", "BCH", "ATOM"],
  2023: ["BTC", "ETH", "BNB", "XRP", "DOGE", "ADA", "MATIC", "DOT", "LTC", "SHIB", "TRX", "SOL", "UNI", "AVAX", "LINK", "ATOM", "XMR", "ETC", "XLM", "BCH"],
  2024: ["BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "AVAX", "DOGE", "TRX", "DOT", "LINK", "MATIC", "ICP", "SHIB", "BCH", "LTC", "IMX", "UNI", "ATOM", "ETC"],
  2025: ["BTC", "ETH", "XRP", "SOL", "BNB", "DOGE", "ADA", "TRX", "AVAX", "LINK", "TON", "SHIB", "SUI", "XLM", "DOT", "HBAR", "BCH", "UNI", "PEPE", "LTC"],
};
const COHORT_YEARS = Object.keys(COIN_COHORTS).map(Number).sort((a, b) => a - b);

/** The list a year trades: its own, or the nearest year's before or after the lists. */
export function cohortFor(year: number): string[] {
  const y = Math.min(COHORT_YEARS[COHORT_YEARS.length - 1], Math.max(COHORT_YEARS[0], year));
  return COIN_COHORTS[y];
}

/** Whether a trade opened at `ms` on `symbol` counts: the coin was on that year's list. */
export function inCohort(symbol: string, ms: number): boolean {
  return cohortFor(new Date(ms).getUTCFullYear()).includes(symbol.split("/")[0]);
}

/** Every coin on any year's list, Bitcoin first. */
export function cohortCoins(): string[] {
  const all = [...new Set(COHORT_YEARS.flatMap((y) => COIN_COHORTS[y]))];
  return ["BTC", ...all.filter((c) => c !== "BTC")].map((c) => `${c}/INR`);
}

export interface DailyLongMarket {
  status: "done" | "failed" | "skipped";
  candles: number;
  firstMs?: number;
  lastMs?: number;
  note?: string;
  /** Its trades in its list years, every trader together, per trailing stop. */
  totals?: Partial<Record<TrailProfileId, TraderRecord>>;
  /** Setups saved for machine learning (its list years), and its file's size (bytes). */
  setups?: number;
  setupBytes?: number;
}

export interface DailyLongRun {
  version: number;
  startedAt: number;
  finishedAt: number | null;
  fromMs: number;
  toMs: number;
  traders: string[];
  markets: Record<string, DailyLongMarket>;
  records: HistoryRecords;
  /** The last finished run's records, kept while this one replays (the daily trades are judged on them). */
  lastRecords?: HistoryRecords;
  /** The classic strategies' results on the same coins and years (CLASSIC_VERSION's). */
  classic?: ClassicRecords;
  classicVersion?: number;
}

export interface DailyLongDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  symbols: () => string[];
  download: (symbol: string, fromMs: number, toMs: number) => Promise<HistoryFetch>;
  spread: (symbol: string) => number | undefined;
  scannerBusy: () => boolean;
}

const realDeps: DailyLongDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  symbols: cohortCoins,
  download: (symbol, fromMs, toMs) => fetchCoinDailySince(symbol, fromMs, toMs),
  spread: typicalSpread,
  scannerBusy: () => scannerHeartbeat().cycleRunning,
};

const dataDir = () => process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data");
const file = () => path.join(dataDir(), "daily_long.json");
/**
 * Every setup in a coin's list years, with its readings and its result under
 * each trailing stop: a compressed CSV per coin (history_setups/ format), for
 * the machine-learning test on daily trades.
 */
export const dailySetupsDir = () => path.join(dataDir(), "daily_long_setups");
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
/** Each coin's daily candles, kept for the classic strategies (a compressed CSV per coin: "t,o,h,l,c,v"). */
export const dailyCandlesDir = () => path.join(dataDir(), "daily_long_candles");
/** Bitcoin's move over this many days is each setup's market reading. */
const MARKET_MOVE_DAYS = 30;
const BTC = "BTC/INR";
const traderIds = () => TRADER_PERSONAS.map((p) => p.id);

let run: DailyLongRun | null = null;
let active: Promise<void> | null = null;
let current: string | null = null;
let total = 0;
let generation = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

export function loadDailyLong(): void {
  try {
    if (!fs.existsSync(file())) return;
    const saved = JSON.parse(fs.readFileSync(file(), "utf8")) as DailyLongRun;
    if (saved && typeof saved === "object" && saved.markets && saved.records) run = saved;
  } catch (err) {
    console.warn("[DailyLong] Couldn't read saved results:", err);
  }
}

function save(): void {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(`${file()}.tmp`, JSON.stringify(run), "utf8");
    fs.renameSync(`${file()}.tmp`, file());
  } catch (err) {
    console.warn("[DailyLong] Couldn't save results:", err);
  }
}

/** Whether the kept results need replaying from the start: none, another version or traders, or a month old. */
export function dailyLongDue(saved: DailyLongRun | null, now: number): boolean {
  if (!saved || saved.version !== DAILY_LONG_VERSION || saved.traders.join() !== traderIds().join()) return true;
  return saved.finishedAt !== null && now - saved.finishedAt > RERUN_AFTER_MS;
}

function mergeRecords(into: HistoryRecords, add: HistoryRecords): void {
  for (const [profile, byPeriod] of Object.entries(add) as [TrailProfileId, Record<string, Record<string, TraderRecord>>][]) {
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

async function work(gen: number, fresh: boolean, deps: DailyLongDeps): Promise<void> {
  const stopped = () => gen !== generation;
  if (fresh || !run) {
    const toMs = Math.floor(deps.now() / DAY_MS) * DAY_MS;
    const lastRecords = dailyLongRecords() ?? undefined;
    fs.rmSync(dailySetupsDir(), { recursive: true, force: true });
    fs.rmSync(dailyCandlesDir(), { recursive: true, force: true });
    run = { version: DAILY_LONG_VERSION, startedAt: deps.now(), finishedAt: null, fromMs: DAILY_LONG_FROM_MS, toMs, traders: traderIds(), markets: {}, records: {}, ...(lastRecords ? { lastRecords } : {}) };
    save();
  }
  const r = run;
  const symbols = deps.symbols();
  total = new Set([...symbols, ...Object.keys(r.markets)]).size;
  const rest = async (took: number) => {
    await deps.sleep(Math.max(1, Math.round(took * (1 / CPU_SHARE - 1))));
    while (deps.scannerBusy()) await deps.sleep(CYCLE_WAIT_MS);
  };

  /** Bitcoin's candles, for every coin's market reading: replayed first, or fetched again after a restart. */
  let btc: CandleSeries | null = null;
  const btcSeries = async (): Promise<CandleSeries | null> => {
    if (!btc) {
      const got = await deps.download(BTC, r.fromMs, r.toMs);
      btc = "error" in got ? null : got.series;
    }
    return btc;
  };

  const replayMarket = async (symbol: string): Promise<boolean> => {
    current = symbol;
    const fetched = await deps.download(symbol, r.fromMs, r.toMs);
    if (symbol === BTC && !("error" in fetched)) btc = fetched.series;
    if (stopped()) return false;
    if ("error" in fetched) {
      r.markets[symbol] = { status: "failed", candles: 0, note: fetched.error };
      save();
      return true;
    }
    const series: CandleSeries = fetched.series;
    await saveCandles(symbol, series);
    const n = series.t.length;
    const market: DailyLongMarket = { status: "done", candles: n, firstMs: series.t[0], lastMs: series.t[n - 1] };
    if (n < TIMEFRAME_RULES["1d"].warmupBars + 20) {
      r.markets[symbol] = { ...market, status: "skipped", note: `Only ${n} days of candles` };
      save();
      return true;
    }
    const records: HistoryRecords = {};
    const rows: string[] = [];
    const market30d = await btcSeries();
    const replay = replayTimeframe(symbol, series, "1d", PROFILES, roundTripFeeRate(symbol), historySpread(symbol, deps.spread(symbol)), {
      marketMove: market30d ? pastMove(market30d, MARKET_MOVE_DAYS, DAY_MS) : undefined,
      // Only setups in a year the coin was on that year's list, like its trades.
      onSetup: (d) => {
        if (inCohort(symbol, d.entryMs)) rows.push(setupCsvRow(d, PROFILES));
      },
    });
    for (;;) {
      const started = deps.now();
      const step: IteratorResult<HistoryTrade[]> = replay.next();
      const took = deps.now() - started;
      if (step.done) break;
      // Only trades opened in a year the coin was on that year's list.
      addToRecords(records, symbol, step.value.filter((t) => inCohort(symbol, t.entryMs)));
      await rest(took);
      if (stopped()) return false;
    }
    const saved = await saveSetups(symbol, rows);
    if (stopped()) return false;
    mergeRecords(r.records, records);
    r.markets[symbol] = { ...market, totals: totalsByProfile(records), ...saved };
    save();
    return true;
  };

  /** Whether this run replays any coin (one that only redoes the classic strategies keeps its finish time). */
  let replayedAny = false;
  for (const symbol of symbols) {
    if (stopped()) return;
    if (r.markets[symbol]) continue;
    if (!(await replayMarket(symbol))) return;
    replayedAny = true;
  }
  // A market that failed (the source busy, say) gets one more try.
  for (const symbol of symbols.filter((s) => r.markets[s]?.status === "failed")) {
    if (stopped()) return;
    delete r.markets[symbol];
    if (!(await replayMarket(symbol))) return;
    replayedAny = true;
  }

  // The classic strategies, on the same coins' kept candles (fetched once more where they weren't kept).
  if (replayedAny || r.classicVersion !== CLASSIC_VERSION) {
    current = null;
    const coins: Record<string, CandleSeries> = {};
    for (const [symbol, m] of Object.entries(r.markets)) {
      if (m.status === "failed") continue;
      let series = await readCandles(symbol);
      if (!series) {
        const got = await deps.download(symbol, r.fromMs, r.toMs);
        if (stopped()) return;
        if ("error" in got) continue;
        series = got.series;
        await saveCandles(symbol, series);
      }
      coins[symbol] = series;
    }
    const classic: ClassicRecords = {};
    const btcCandles = coins[BTC];
    const btcUp = btcCandles ? btcUptrend(btcCandles) : () => undefined;
    const costFor = (symbol: string) => roundTripFeeRate(symbol) + historySpread(symbol, deps.spread(symbol));
    for (const [symbol, series] of Object.entries(coins)) {
      const started = deps.now();
      const eligible = (ms: number) => inCohort(symbol, ms);
      addClassicTrades(classic, breakoutTrades(symbol, series, costFor(symbol), eligible));
      addClassicTrades(classic, maTrendTrades(symbol, series, btcUp, costFor(symbol), eligible));
      await rest(deps.now() - started);
      if (stopped()) return;
    }
    const started = deps.now();
    addClassicTrades(classic, momentumTrades(coins, btcUp, costFor, inCohort));
    await rest(deps.now() - started);
    if (stopped()) return;
    r.classic = classic;
    r.classicVersion = CLASSIC_VERSION;
  }
  if (replayedAny || r.finishedAt === null) r.finishedAt = deps.now();
  save();
  console.log(`[DailyLong] Replayed ${Object.values(r.markets).filter((m) => m.status === "done").length} of ${symbols.length} coins on daily candles since 2017, and the classic strategies.`);
}

/** Writes a coin's daily candles (compressed CSV). */
async function saveCandles(symbol: string, s: CandleSeries): Promise<void> {
  try {
    const lines = s.t.map((t, k) => `${t},${s.o[k]},${s.h[k]},${s.l[k]},${s.c[k]},${s.v[k]}`);
    const data = await gzipAsync(Buffer.from(`t,o,h,l,c,v\n${lines.join("\n")}\n`));
    fs.mkdirSync(dailyCandlesDir(), { recursive: true });
    const target = path.join(dailyCandlesDir(), setupsFileName(symbol));
    fs.writeFileSync(`${target}.tmp`, data);
    fs.renameSync(`${target}.tmp`, target);
  } catch (err) {
    console.warn(`[DailyLong] Couldn't save ${symbol}'s candles:`, err);
  }
}

/** A coin's kept daily candles, or null without them. */
async function readCandles(symbol: string): Promise<CandleSeries | null> {
  const target = path.join(dailyCandlesDir(), setupsFileName(symbol));
  if (!fs.existsSync(target)) return null;
  try {
    const out: CandleSeries = { t: [], o: [], h: [], l: [], c: [], v: [] };
    for (const line of (await gunzipAsync(fs.readFileSync(target))).toString().split("\n").slice(1)) {
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
    console.warn(`[DailyLong] Couldn't read ${symbol}'s candles:`, err);
    return null;
  }
}

/** Writes a coin's setups (compressed CSV); none when it had none. */
async function saveSetups(symbol: string, rows: string[]): Promise<{ setups: number; setupBytes: number }> {
  if (rows.length === 0) return { setups: 0, setupBytes: 0 };
  try {
    const data = await gzipAsync(Buffer.from(`${setupCsvHeader(PROFILES)}\n${rows.join("\n")}\n`));
    fs.mkdirSync(dailySetupsDir(), { recursive: true });
    const target = path.join(dailySetupsDir(), setupsFileName(symbol));
    fs.writeFileSync(`${target}.tmp`, data);
    fs.renameSync(`${target}.tmp`, target);
    return { setups: rows.length, setupBytes: data.length };
  } catch (err) {
    console.warn(`[DailyLong] Couldn't save ${symbol}'s setups:`, err);
    return { setups: 0, setupBytes: 0 };
  }
}

/** Starts a run unless one is going: from the start when `fresh` or due, otherwise carrying on with the kept one. */
export function startDailyLong(fresh: boolean, deps: DailyLongDeps = realDeps): Promise<void> {
  if (active && !fresh) return active;
  const gen = ++generation;
  const job = work(gen, fresh || dailyLongDue(run, deps.now()), deps)
    .catch((err) => console.error("[DailyLong] Run failed:", err))
    .finally(() => {
      if (gen !== generation) return;
      active = null;
      current = null;
    });
  active = job;
  return job;
}

/** Loads kept results, then checks every few hours whether a run is due, never alongside the other background work. */
export function startDailyLongJob(): void {
  loadDailyLong();
  waitForOtherWork(() => active !== null);
  const check = () => {
    timer = setTimeout(check, CHECK_EVERY_MS);
    const due = dailyLongDue(run, Date.now()) || (run !== null && (run.finishedAt === null || run.classicVersion !== CLASSIC_VERSION));
    if (!active && !historyRunning() && !backgroundWorkBusy() && due) void startDailyLong(false);
  };
  timer = setTimeout(check, START_DELAY_MS);
}

/** What the Lab shows: progress, the results so far, and each year's coins. */
export function dailyLongView() {
  const markets = run?.markets ?? {};
  return {
    running: active !== null,
    current,
    finished: Object.keys(markets).length,
    total: active ? total : Object.keys(markets).length,
    run: run
      ? {
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          fromMs: run.fromMs,
          toMs: run.toMs,
          done: Object.values(markets).filter((m) => m.status === "done").length,
          /** Setups saved for the machine-learning test. */
          setups: Object.values(markets).reduce((n, m) => n + (m.setups ?? 0), 0),
          problems: Object.entries(markets)
            .filter(([, m]) => m.status !== "done")
            .map(([symbol, m]) => ({ symbol, note: m.note ?? m.status })),
        }
      : null,
    records: run?.records ?? {},
    /** The classic strategies' results on the same coins and years, by quarter (null until they've run). */
    classic: run?.classic ?? null,
    /** Each coin's own result in its list years. */
    byMarket: Object.fromEntries(Object.entries(markets).flatMap(([symbol, m]) => (m.status === "done" && m.totals ? [[symbol, m.totals]] : []))) as Record<
      string,
      Partial<Record<TrailProfileId, TraderRecord>>
    >,
    cohorts: COIN_COHORTS,
  };
}

/** Test hooks. */
export function _resetDailyLong(): void {
  generation++;
  run = null;
  active = null;
  current = null;
  total = 0;
  if (timer) clearTimeout(timer);
  timer = null;
}
/**
 * The finished replay's records (the last finished one's while the next
 * replays), or null before any has finished: what the daily coin trades
 * judge each trader on.
 */
export function dailyLongRecords(): HistoryRecords | null {
  if (!run) return null;
  return run.finishedAt !== null ? run.records : run.lastRecords ?? null;
}

/** The kept run (finished or not), for the machine-learning test. */
export function dailyLongRunInfo(): DailyLongRun | null {
  return run;
}

/** A replay since 2017 is under way. */
export function dailyLongRunning(): boolean {
  return active !== null;
}

export function _dailyLongRun(): DailyLongRun | null {
  return run;
}
