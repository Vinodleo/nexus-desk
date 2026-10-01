import fs from "fs";
import path from "path";
import { getCoinUniverse } from "../coinUniverse";
import { fetchCoinHistory, fetchNseHistory, fetchUsHistory, type HistoryFetch } from "./historyCandles";
import { scannerHeartbeat, stockUniverse, typicalSpread, usUniverse } from "../scanner/scannerService";
import { addToRecords, replayHistory, type HistoryRecords } from "../../src/services/historyReplay";
import { TRADER_PERSONAS } from "../../src/services/personaEngine";
import { TRAIL_PROFILES, type TrailProfileId } from "../../src/shared/trailingStop";
import { spreadTooWide } from "../../src/shared/tradeCosts";
import { isNseOpen, isNseSymbol } from "../../src/shared/nse";
import { isUsSymbol } from "../../src/shared/usMarket";

// The traders over the last two years: each market's 5-minute candles are
// downloaded and replayed (src/services/historyReplay.ts) in the background,
// one market at a time, and only the results are kept (on the volume, so a
// restart carries on from the next market). It runs a while after the
// server starts, then again weekly, or when the traders change.
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
export const HISTORY_VERSION = 1;
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

const file = () => path.join(process.env.NEXUS_DATA_DIR || path.join(process.cwd(), "data"), "history_results.json");

export interface HistoryMarket {
  status: "done" | "failed" | "skipped";
  candles: number;
  /** The first and last candle replayed (ms). */
  firstMs?: number;
  lastMs?: number;
  /** Why it failed or was skipped. */
  note?: string;
}

export interface HistoryRun {
  version: number;
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
  symbols: async () => [...(await getCoinUniverse()).coins.map((c) => c.symbol), ...usUniverse(), ...stockUniverse()],
  download: (symbol, fromMs, toMs) =>
    isUsSymbol(symbol) ? fetchUsHistory(symbol, fromMs, toMs) : isNseSymbol(symbol) ? fetchNseHistory(symbol, fromMs, toMs) : fetchCoinHistory(symbol, fromMs, toMs),
  spread: typicalSpread,
  scannerBusy: () => scannerHeartbeat().cycleRunning,
};

let run: HistoryRun | null = null;
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
    const toMs = Math.floor(deps.now() / DAY_MS) * DAY_MS;
    run = { version: HISTORY_VERSION, startedAt: deps.now(), finishedAt: null, fromMs: toMs - HISTORY_DAYS * DAY_MS, toMs, traders: traderIds(), markets: {}, records: {} };
    saveHistory();
  }
  const r = run;
  const symbols = await deps.symbols();
  total = symbols.length;

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
    const spread = deps.spread(symbol) ?? 0;
    const skip = series.t.length < MIN_CANDLES ? `Only ${series.t.length} candles` : spreadTooWide(symbol, spread) ? "Its spread is too wide to trade" : null;
    const market: HistoryMarket = { status: skip ? "skipped" : "done", candles: series.t.length, firstMs: series.t[0], lastMs: series.t[series.t.length - 1] };
    if (skip) {
      r.markets[symbol] = { ...market, note: skip };
      saveHistory();
      return true;
    }
    phase = "replaying";
    // This market's results join the others only once it's done, so a stop part-way leaves none of it.
    const records: HistoryRecords = {};
    const replay = replayHistory(symbol, series, PROFILES, spread);
    for (;;) {
      const started = deps.now();
      const step = replay.next();
      const took = deps.now() - started;
      if (step.done) break;
      addToRecords(records, symbol, step.value);
      // Rest so the replay averages CPU_SHARE of a core, and let a scan cycle finish first.
      await deps.sleep(Math.max(1, Math.round(took * (1 / CPU_SHARE - 1))));
      while (deps.scannerBusy()) await deps.sleep(CYCLE_WAIT_MS);
      if (stopped()) return false;
    }
    mergeRecords(r.records, records);
    r.markets[symbol] = market;
    saveHistory();
    return true;
  };

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
  r.finishedAt = deps.now();
  saveHistory();
  console.log(`[History] Replayed ${Object.values(r.markets).filter((m) => m.status === "done").length} of ${symbols.length} markets over ${HISTORY_DAYS} days.`);
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

/** Loads kept results and checks a while after start, then every few hours, whether a run is due. */
export function startHistoryJob(): void {
  loadHistory();
  const check = () => {
    timer = setTimeout(check, CHECK_EVERY_MS);
    if (!active && (needsRun(run, Date.now()) || (run && run.finishedAt === null))) void startHistoryRun(false);
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
          problems: Object.entries(markets)
            .filter(([, m]) => m.status !== "done")
            .slice(0, 12)
            .map(([symbol, m]) => ({ symbol, note: m.note ?? m.status })),
        }
      : null,
    records: run?.records ?? {},
  };
}

/** Test hooks. */
export function _resetHistoryJob(): void {
  generation++;
  run = null;
  phase = "idle";
  current = null;
  total = 0;
  active = null;
  if (timer) clearTimeout(timer);
  timer = null;
}

export function _historyRun(): HistoryRun | null {
  return run;
}
