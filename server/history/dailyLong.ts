import fs from "fs";
import path from "path";
import { addToRecords, replayTimeframe, totalsByProfile, type CandleSeries, type HistoryRecords, type HistoryTrade, TIMEFRAME_RULES } from "../../src/services/historyReplay";
import type { TraderRecord } from "../../src/services/exitExpectancy";
import { TRADER_PERSONAS } from "../../src/services/personaEngine";
import { TRAIL_PROFILES, type TrailProfileId } from "../../src/shared/trailingStop";
import { roundTripFeeRate } from "../../src/shared/tradeCosts";
import { fetchCoinDailySince, type HistoryFetch } from "./historyCandles";
import { backgroundWorkBusy, CPU_SHARE, historyRunning, historySpread, waitForOtherWork } from "./historyJob";
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
export const DAILY_LONG_VERSION = 1;
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

const file = () => path.join(process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data"), "daily_long.json");
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
    run = { version: DAILY_LONG_VERSION, startedAt: deps.now(), finishedAt: null, fromMs: DAILY_LONG_FROM_MS, toMs, traders: traderIds(), markets: {}, records: {} };
    save();
  }
  const r = run;
  const symbols = deps.symbols();
  total = new Set([...symbols, ...Object.keys(r.markets)]).size;
  const rest = async (took: number) => {
    await deps.sleep(Math.max(1, Math.round(took * (1 / CPU_SHARE - 1))));
    while (deps.scannerBusy()) await deps.sleep(CYCLE_WAIT_MS);
  };

  const replayMarket = async (symbol: string): Promise<boolean> => {
    current = symbol;
    const fetched = await deps.download(symbol, r.fromMs, r.toMs);
    if (stopped()) return false;
    if ("error" in fetched) {
      r.markets[symbol] = { status: "failed", candles: 0, note: fetched.error };
      save();
      return true;
    }
    const series: CandleSeries = fetched.series;
    const n = series.t.length;
    const market: DailyLongMarket = { status: "done", candles: n, firstMs: series.t[0], lastMs: series.t[n - 1] };
    if (n < TIMEFRAME_RULES["1d"].warmupBars + 20) {
      r.markets[symbol] = { ...market, status: "skipped", note: `Only ${n} days of candles` };
      save();
      return true;
    }
    const records: HistoryRecords = {};
    const replay = replayTimeframe(symbol, series, "1d", PROFILES, roundTripFeeRate(symbol), historySpread(symbol, deps.spread(symbol)));
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
    mergeRecords(r.records, records);
    r.markets[symbol] = { ...market, totals: totalsByProfile(records) };
    save();
    return true;
  };

  for (const symbol of symbols) {
    if (stopped()) return;
    if (!r.markets[symbol] && !(await replayMarket(symbol))) return;
  }
  // A market that failed (the source busy, say) gets one more try.
  for (const symbol of symbols.filter((s) => r.markets[s]?.status === "failed")) {
    if (stopped()) return;
    delete r.markets[symbol];
    if (!(await replayMarket(symbol))) return;
  }
  r.finishedAt = deps.now();
  save();
  console.log(`[DailyLong] Replayed ${Object.values(r.markets).filter((m) => m.status === "done").length} of ${symbols.length} coins on daily candles since 2017.`);
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
    const due = dailyLongDue(run, Date.now()) || (run !== null && run.finishedAt === null);
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
          problems: Object.entries(markets)
            .filter(([, m]) => m.status !== "done")
            .map(([symbol, m]) => ({ symbol, note: m.note ?? m.status })),
        }
      : null,
    records: run?.records ?? {},
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
export function _dailyLongRun(): DailyLongRun | null {
  return run;
}
