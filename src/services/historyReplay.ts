import type { MarketBar, RegimeType, StrategySetup } from "../types";
import { decorateBarsWithIndicators } from "./marketDataService";
import { LAB_INTERVAL_MS, panelSetupsOnHistory, REPLAY_COOLDOWN_BARS } from "./labSimulation";
import { simulateExit } from "./exitComparison";
import { expectancyKey, MARKET_KINDS, type MarketKind, type TraderRecord } from "./exitExpectancy";
import { costsTooBigForStop, MAX_COST_SHARE_OF_STOP } from "../shared/tradeCosts";
import type { TrailProfileId } from "../shared/trailingStop";
import { sessionClock } from "../shared/sessionBars";
import { DAILY_HOLD_MINUTES } from "../shared/coinHolds";
import { IST_OFFSET_MS, isNseSymbol, NSE_OPEN } from "../shared/nse";
import { isUsSymbol, US_OPEN } from "../shared/usMarket";

// The traders over years of history: every setup each trader would have put
// forward on a market's past 5-minute candles, played forward under the live
// exits after fees and the spread, one trade at a time per trader, exactly
// as "Traders with your exits" does for the last 30 days. Every exit profile
// is played on the same setups, so they can be compared.
//
// Years of candles are too many to decorate and replay at once on the
// server, so they're replayed a chunk at a time: each chunk is decorated with
// a warm-up of earlier candles before it (so the indicators and the 1-hour
// trend have settled) and room after it for its last trades to close. The
// traders see at most the candles the server holds live.

/** A market's raw candles, oldest first, one array per field (compact: years of them are kept per market). */
export interface CandleSeries {
  /** Open times, ms. */
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

/** One setup played out under one exit profile. */
export interface HistoryTrade {
  trader: string;
  profile: TrailProfileId;
  /** Candle close it opened at, and the one it closed at (ms). */
  entryMs: number;
  exitMs: number;
  /** Result in R, after fees and the spread. */
  r: number;
}

/** What the traders see at each candle: the candles the server holds live (marketData's FULL_CANDLES). */
export const HISTORY_VIEW_BARS = 300;
/** Candles decorated together. */
export const CHUNK_BARS = 2000;
/** Candles judged between pauses (a fraction of a second of work). */
export const SLICE_BARS = 500;
/** Candles before a chunk for its indicators and 1-hour trend (30+ hours of coin candles, 8 stock sessions). */
export const CHUNK_WARMUP_BARS = 600;
/** Candles after a chunk for its last trades to close: a coin's 4-hour limit, extended to 12 hours for one in profit. */
export const CHUNK_TAIL_BARS = 160;

export function emptySeries(): CandleSeries {
  return { t: [], o: [], h: [], l: [], c: [], v: [] };
}

/** Adds candles (any order) to a series: only those after its last, so pages fetched oldest first can overlap. */
export function appendBars(series: CandleSeries, bars: MarketBar[]): void {
  for (const b of [...bars].sort((a, z) => (a.timestampMs as number) - (z.timestampMs as number))) {
    const t = b.timestampMs as number;
    if (!Number.isFinite(t) || (series.t.length > 0 && t <= series.t[series.t.length - 1])) continue;
    series.t.push(t);
    series.o.push(b.open);
    series.h.push(b.high);
    series.l.push(b.low);
    series.c.push(b.close);
    series.v.push(b.volume);
  }
}

function barsOf(s: CandleSeries, from: number, to: number): MarketBar[] {
  const bars: MarketBar[] = [];
  for (let k = from; k < to; k++) {
    bars.push({ time: new Date(s.t[k]).toISOString(), timestampMs: s.t[k], open: s.o[k], high: s.h[k], low: s.l[k], close: s.c[k], volume: s.v[k] });
  }
  return bars;
}

/**
 * The readings saved with each setup, in this order: the trader's own (RSI,
 * ADX, volume against usual, distance from VWAP), the candle's (ATR, the
 * EMAs' order, the last hour's and four hours' change, in %), the plan's
 * (stop distance, target against stop), and the market's last hour
 * (Bitcoin's for coins, SPY's for US stocks; none for Indian ones).
 */
export const SETUP_READINGS = [
  "rsi",
  "adx",
  "volSurge",
  "vwapDistPct",
  "atrPct",
  "stopPct",
  "rewardRisk",
  "ema9vs21Pct",
  "ema21vs50Pct",
  "vsEma200Pct",
  "chg1hPct",
  "chg4hPct",
  "market1hPct",
] as const;

/** One setup as it came, with what was known then and how it played out under each exit profile: a row for machine learning. */
export interface SetupDetail {
  /** Candle close it came at (ms). */
  entryMs: number;
  trader: string;
  direction: "LONG" | "SHORT";
  /** The 5-minute and 1-hour trend then. */
  regime: string;
  macro: string;
  /** Minutes after midnight and weekday (0 Sunday) in the market's own time: New York, IST, or UTC for coins. */
  minute: number;
  weekday: number;
  /** SETUP_READINGS, in order (null where there weren't enough candles). */
  readings: (number | null)[];
  /** Each exit profile's result in R after costs, and candles held; absent where the history ended first. */
  results: Partial<Record<TrailProfileId, { r: number; bars: number }>>;
}

const pct = (a: number | undefined, b: number | undefined) => (a !== undefined && b !== undefined && b > 0 ? ((a - b) / b) * 100 : null);

function setupDetail(
  symbol: string,
  bars: MarketBar[],
  i: number,
  setup: StrategySetup,
  regime: string,
  macro: string,
  entryMs: number,
  marketMove: ((ms: number) => number | null) | undefined
): Omit<SetupDetail, "results"> {
  const bar = bars[i];
  const risk = Math.abs(setup.entryPrice - setup.stopLoss);
  const clock = sessionClock(symbol);
  let minute: number;
  let weekday: number;
  if (clock) {
    const { day, minutes } = clock.parts(entryMs);
    minute = minutes;
    weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  } else {
    minute = Math.floor(entryMs / 60_000) % 1440;
    weekday = new Date(entryMs).getUTCDay();
  }
  return {
    entryMs,
    trader: setup.name,
    direction: setup.direction,
    regime,
    macro,
    minute,
    weekday,
    readings: [
      setup.features.rsi,
      setup.features.adx,
      setup.features.volumeSurgeRatio,
      setup.features.vwapDistancePercent,
      bar.atr !== undefined && bar.close > 0 ? (bar.atr / bar.close) * 100 : null,
      setup.entryPrice > 0 ? (risk / setup.entryPrice) * 100 : null,
      risk > 0 ? Math.abs(setup.takeProfit - setup.entryPrice) / risk : null,
      pct(bar.ema9, bar.ema21),
      pct(bar.ema21, bar.ema50),
      pct(bar.close, bar.ema200),
      i >= 12 ? pct(bar.close, bars[i - 12].close) : null,
      i >= 48 ? pct(bar.close, bars[i - 48].close) : null,
      marketMove?.(entryMs) ?? null,
    ],
  };
}

/** A slice of the replay: the trades taken (one at a time) and every setup found, with its details. */
export interface ReplayStep {
  trades: HistoryTrade[];
  setups: SetupDetail[];
}

/**
 * Replays a market's history a chunk at a time, yielding what it found
 * every SLICE_BARS candles (so a caller can pause in between). Every setup
 * is played out under each exit profile and kept with its details; the
 * trades are those taken one at a time per trader and exit profile, across
 * chunks. Results still open when the history ends are left out.
 */
export function* replayHistory(
  symbol: string,
  series: CandleSeries,
  profiles: TrailProfileId[],
  /** The market's bid-ask spread, paid once per trade (share of price). */
  spreadPct: number = 0,
  /** The market's last hour at a time (Bitcoin's or SPY's change, %), for the setup details. */
  marketMove?: (ms: number) => number | null
): Generator<ReplayStep> {
  const n = series.t.length;
  /** When each trader's last trade under each profile closes. */
  const busyUntil = new Map<string, number>();
  const closeMs = (bars: MarketBar[], k: number) => (bars[k].timestampMs as number) + LAB_INTERVAL_MS;
  for (let start = CHUNK_WARMUP_BARS; start < n - 1; start += CHUNK_BARS) {
    const end = Math.min(n - 1, start + CHUNK_BARS);
    const first = start - CHUNK_WARMUP_BARS;
    const bars = decorateBarsWithIndicators(barsOf(series, first, Math.min(n, end + CHUNK_TAIL_BARS)));
    for (let from = start; from < end; from += SLICE_BARS) {
      const step: ReplayStep = { trades: [], setups: [] };
      const found = panelSetupsOnHistory(symbol, bars, undefined, { from: from - first, to: Math.min(end, from + SLICE_BARS) - first, view: HISTORY_VIEW_BARS });
      for (const { i, regime, macro, setups } of found) {
        const entryMs = closeMs(bars, i);
        for (const setup of setups) {
          // Not taken live either: its costs would eat too much of the stop.
          if (costsTooBigForStop(symbol, setup.entryPrice, setup.stopLoss, spreadPct)) continue;
          const detail: SetupDetail = { ...setupDetail(symbol, bars, i, setup, regime, macro, entryMs, marketMove), results: {} };
          for (const profile of profiles) {
            const result = simulateExit(setup, bars, i, profile, spreadPct);
            if (!result || result.open) continue;
            detail.results[profile] = { r: result.r, bars: result.exitIndex - i };
            const key = `${profile}|${setup.name}`;
            if (entryMs < (busyUntil.get(key) ?? 0)) continue;
            const exitMs = closeMs(bars, result.exitIndex);
            busyUntil.set(key, exitMs);
            step.trades.push({ trader: setup.name, profile, entryMs, exitMs, r: result.r });
          }
          step.setups.push(detail);
        }
      }
      yield step;
    }
  }
}

/** The saved setups' columns: when and who, the trend, the time, SETUP_READINGS, then each profile's result and candles held. */
export function setupCsvHeader(profiles: TrailProfileId[]): string {
  return ["entryMs", "trader", "direction", "regime", "macro", "minute", "weekday", ...SETUP_READINGS, ...profiles.flatMap((p) => [`r_${p}`, `bars_${p}`])].join(",");
}

const num = (x: number | null | undefined, digits: number) => (x === null || x === undefined || !Number.isFinite(x) ? "" : String(Number(x.toFixed(digits))));

/** A saved setup as a CSV line (no commas appear in trader names or trends). */
export function setupCsvRow(d: SetupDetail, profiles: TrailProfileId[]): string {
  return [
    d.entryMs,
    d.trader,
    d.direction,
    d.regime,
    d.macro,
    d.minute,
    d.weekday,
    ...d.readings.map((x) => num(x, 3)),
    ...profiles.flatMap((p) => [num(d.results[p]?.r, 3), d.results[p]?.bars ?? ""]),
  ].join(",");
}

/**
 * A market's change over its last `candles` closed candles (each
 * `intervalMs` long) at a time, from its series (%); null without enough of
 * them or a recent one.
 */
export function pastMove(series: CandleSeries, candles: number, intervalMs: number): (ms: number) => number | null {
  return (ms) => {
    let lo = 0;
    let hi = series.t.length - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (series.t[mid] + intervalMs <= ms) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (k < candles || ms - (series.t[k] + intervalMs) > intervalMs) return null;
    return pct(series.c[k], series.c[k - candles]);
  };
}

/** A market's change over the last hour (12 closed 5-minute candles) at a time, from its series; null when it has no recent candle. */
export function lastHourMove(series: CandleSeries): (ms: number) => number | null {
  return (ms) => {
    // The last candle closed by `ms`.
    let lo = 0;
    let hi = series.t.length - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (series.t[mid] + LAB_INTERVAL_MS <= ms) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (k < 12 || ms - (series.t[k] + LAB_INTERVAL_MS) > 30 * 60_000) return null;
    return pct(series.c[k], series.c[k - 12]);
  };
}

/** Results by exit profile, then period ("2025-Q3"), then market and trader (expectancyKey). */
export type HistoryRecords = Partial<Record<TrailProfileId, Record<string, Record<string, TraderRecord>>>>;

/** The calendar quarter a time falls in (UTC), e.g. "2025-Q3". */
export function quarterOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

/** Adds a market's trades to the records. */
export function addToRecords(records: HistoryRecords, symbol: string, trades: HistoryTrade[]): void {
  for (const t of trades) {
    const byPeriod = (records[t.profile] ??= {});
    const byKey = (byPeriod[quarterOf(t.entryMs)] ??= {});
    const rec = (byKey[expectancyKey(symbol, t.trader)] ??= { trades: 0, totalR: 0, wins: 0, winR: 0, lossR: 0 });
    rec.trades++;
    rec.totalR += t.r;
    if (t.r > 0) {
      rec.wins++;
      rec.winR += t.r;
    } else rec.lossR += t.r;
  }
}

/** Sums records (several periods, or several markets' traders). */
export function sumRecords(records: (TraderRecord | undefined)[]): TraderRecord {
  const out: TraderRecord = { trades: 0, totalR: 0, wins: 0, winR: 0, lossR: 0 };
  for (const r of records) {
    if (!r) continue;
    out.trades += r.trades;
    out.totalR += r.totalR;
    out.wins += r.wins;
    out.winR += r.winR;
    out.lossR += r.lossR;
  }
  return out;
}

/** A record's figures for display. */
export function recordStats(rec: TraderRecord) {
  const losses = rec.trades - rec.wins;
  return {
    trades: rec.trades,
    winPct: rec.trades > 0 ? Math.round((rec.wins / rec.trades) * 100) : 0,
    avgWinR: rec.wins > 0 ? rec.winR / rec.wins : 0,
    avgLossR: losses > 0 ? rec.lossR / losses : 0,
    avgR: rec.trades > 0 ? rec.totalR / rec.trades : 0,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The periods in the records, newest last, paired into half-years counted
 * back from the newest quarter (so the latest half is always a full pair
 * when there is one), with labels like "Apr–Sep 2026".
 */
export function halfYears(periods: string[]): { label: string; quarters: string[] }[] {
  const sorted = [...new Set(periods)].sort();
  const out: { label: string; quarters: string[] }[] = [];
  for (let end = sorted.length; end > 0; end -= 2) {
    const quarters = sorted.slice(Math.max(0, end - 2), end);
    const [y0, q0] = quarters[0].split("-Q").map(Number);
    const [y1, q1] = quarters[quarters.length - 1].split("-Q").map(Number);
    const first = MONTHS[(q0 - 1) * 3];
    const last = MONTHS[(q1 - 1) * 3 + 2];
    out.unshift({ label: y0 === y1 ? `${first}–${last} ${y1}` : `${first} ${y0}–${last} ${y1}`, quarters });
  }
  return out;
}

export interface HistoryRow extends ReturnType<typeof recordStats> {
  market: MarketKind;
  trader: string;
  /** Average result per setup in each half-year (null with none), oldest first, as `halfYears` labels them. */
  halves: { avgR: number | null; trades: number }[];
}

/** Each market's traders under one exit profile over the whole history, best first, with each half-year's result. */
export function historyRows(records: HistoryRecords, profile: TrailProfileId): { halves: string[]; rows: HistoryRow[] } {
  const byPeriod = records[profile] ?? {};
  const halves = halfYears(Object.keys(byPeriod));
  const keys = new Set(Object.values(byPeriod).flatMap((byKey) => Object.keys(byKey)));
  const rows = [...keys].map((key): HistoryRow => {
    const [market, ...name] = key.split(":");
    const whole = sumRecords(Object.values(byPeriod).map((byKey) => byKey[key]));
    return {
      market: market as MarketKind,
      trader: name.join(":"),
      ...recordStats(whole),
      halves: halves.map((h) => {
        const rec = sumRecords(h.quarters.map((q) => byPeriod[q]?.[key]));
        return { avgR: rec.trades > 0 ? rec.totalR / rec.trades : null, trades: rec.trades };
      }),
    };
  });
  rows.sort((a, b) => (a.market === b.market ? b.avgR - a.avgR : a.market.localeCompare(b.market)));
  return { halves: halves.map((h) => h.label), rows };
}

/** Every trader's setups together in each market, under each exit profile: which exits do best. */
export function profileTotals(records: HistoryRecords): { market: MarketKind; profile: TrailProfileId; stats: ReturnType<typeof recordStats> }[] {
  const out: { market: MarketKind; profile: TrailProfileId; stats: ReturnType<typeof recordStats> }[] = [];
  for (const [profile, byPeriod] of Object.entries(records) as [TrailProfileId, Record<string, Record<string, TraderRecord>>][]) {
    for (const market of MARKET_KINDS) {
      const recs = Object.values(byPeriod).flatMap((byKey) => Object.entries(byKey).filter(([k]) => k.startsWith(`${market}:`)).map(([, r]) => r));
      const sum = sumRecords(recs);
      if (sum.trades > 0) out.push({ market, profile, stats: recordStats(sum) });
    }
  }
  return out;
}

// ---------- slower trades: the same traders on 1-hour and 1-day candles ----------
// Trades on 5-minute candles risk about 1% for moves too small to pay their
// costs. Here the same traders read hourly or daily candles instead: their
// stops are sized on those candles' own volatility (so wider), trades may
// run for days (stocks held overnight: Indian ones as delivery trades, with
// their higher charges), and the higher timeframe they check is a day
// (above hourly candles) or a week (above daily ones). Exits are the live
// ones otherwise: the trailing stop, half banked at +1R, a time limit.

export type Timeframe = "1h" | "1d";
export const TIMEFRAMES: Timeframe[] = ["1h", "1d"];
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const TIMEFRAME_RULES: Record<Timeframe, { intervalMs: number; higherMs: number; holdMs: number; warmupBars: number; anyTime: boolean }> = {
  // Taken in stocks' entry hours, as live; held up to 5 days.
  "1h": { intervalMs: HOUR_MS, higherMs: DAY_MS, holdMs: 5 * DAY_MS, warmupBars: 250, anyTime: false },
  // Taken at the day's close; held up to 30 days.
  "1d": { intervalMs: DAY_MS, higherMs: 7 * DAY_MS, holdMs: DAILY_HOLD_MINUTES * 60_000, warmupBars: 210, anyTime: true },
};

/**
 * Where a market's hours start, past the UTC hour: on the hour for coins,
 * from the open for stocks (9:15 IST is 03:45 UTC; 9:30 New York is :30 UTC
 * in summer and winter alike, New York being whole hours from UTC).
 */
export function hourOffsetMs(symbol: string): number {
  if (isNseSymbol(symbol)) return ((((NSE_OPEN - IST_OFFSET_MS / 60_000) % 60) + 60) % 60) * 60_000;
  if (isUsSymbol(symbol)) return (US_OPEN % 60) * 60_000;
  return 0;
}

/** 5-minute candles as longer ones (`periodMs`), each starting `offsetMs` past the period's boundary. */
export function aggregateSeries(series: CandleSeries, periodMs: number, offsetMs: number = 0): CandleSeries {
  const out = emptySeries();
  for (let k = 0; k < series.t.length; k++) {
    const start = Math.floor((series.t[k] - offsetMs) / periodMs) * periodMs + offsetMs;
    const last = out.t.length - 1;
    if (last >= 0 && out.t[last] === start) {
      out.h[last] = Math.max(out.h[last], series.h[k]);
      out.l[last] = Math.min(out.l[last], series.l[k]);
      out.c[last] = series.c[k];
      out.v[last] += series.v[k];
    } else {
      out.t.push(start);
      out.o.push(series.o[k]);
      out.h.push(series.h[k]);
      out.l.push(series.l[k]);
      out.c.push(series.c[k]);
      out.v.push(series.v[k]);
    }
  }
  return out;
}

/** A market's candles for a timeframe, from its hourly ones. */
export function timeframeSeries(hourly: CandleSeries, tf: Timeframe): CandleSeries {
  return tf === "1h" ? hourly : aggregateSeries(hourly, DAY_MS, 0);
}

/**
 * Replays a market's slower candles (`series`, already `tf` long), yielding
 * the trades taken every SLICE_BARS candles: one at a time per trader and
 * exit profile, charged `feeRate` a round trip (a share of the price) plus
 * the spread. Setups whose costs would take more than MAX_COST_SHARE_OF_STOP
 * of the stop aren't taken, as live.
 */
export function* replayTimeframe(
  symbol: string,
  series: CandleSeries,
  tf: Timeframe,
  profiles: TrailProfileId[],
  feeRate: number,
  spreadPct: number = 0,
  opts: {
    /** Every setup taken into account, with its details and result under each profile (machine learning's rows). */
    onSetup?: (detail: SetupDetail) => void;
    /** The market's move at a time (Bitcoin's), for the details. */
    marketMove?: (ms: number) => number | null;
  } = {}
): Generator<HistoryTrade[]> {
  const rules = TIMEFRAME_RULES[tf];
  const n = series.t.length;
  if (n < rules.warmupBars + 20) return;
  const bars = slowBars(series);
  const held = { intervalMs: rules.intervalMs, holdMs: rules.holdMs, feeRate };
  const busyUntil = new Map<string, number>();
  const closeMs = (k: number) => (bars[k].timestampMs as number) + rules.intervalMs;
  for (let from = rules.warmupBars; from < n - 1; from += SLICE_BARS) {
    const trades: HistoryTrade[] = [];
    const found = panelSetupsOnHistory(symbol, bars, undefined, {
      from,
      to: Math.min(n - 1, from + SLICE_BARS),
      view: HISTORY_VIEW_BARS,
      intervalMs: rules.intervalMs,
      higherMs: rules.higherMs,
      anyTime: rules.anyTime,
    });
    for (const { i, regime, macro, setups } of found) {
      const entryMs = closeMs(i);
      for (const setup of setups) {
        const risk = Math.abs(setup.entryPrice - setup.stopLoss);
        if (!(risk > 0) || ((feeRate + spreadPct) * setup.entryPrice) / risk > MAX_COST_SHARE_OF_STOP) continue;
        // With details asked for, every setup is played out, not only those a free trader takes.
        const detail: SetupDetail | null = opts.onSetup
          ? { ...setupDetail(symbol, bars, i, setup, regime, macro, entryMs, opts.marketMove), results: {} }
          : null;
        for (const profile of profiles) {
          const key = `${profile}|${setup.name}`;
          const busy = entryMs < (busyUntil.get(key) ?? 0);
          if (busy && !detail) continue;
          const result = simulateExit(setup, bars, i, profile, spreadPct, held);
          if (!result || result.open) continue;
          if (detail) detail.results[profile] = { r: result.r, bars: result.exitIndex - i };
          if (busy) continue;
          const exitMs = closeMs(result.exitIndex);
          busyUntil.set(key, exitMs);
          trades.push({ trader: setup.name, profile, entryMs, exitMs, r: result.r });
        }
        if (detail) opts.onSetup!(detail);
      }
    }
    yield trades;
  }
}

/** Candles before the last that latestSlowSetups replays, for the traders' spacing (REPLAY_COOLDOWN_BARS) to carry over as in the replay. */
export const SPACING_LOOKBACK_BARS = 10 * REPLAY_COOLDOWN_BARS;

/** A market's slower candles with their indicators; their own volatility plans the stops (planAtr reads it as the hourly one). */
function slowBars(series: CandleSeries): MarketBar[] {
  const bars = decorateBarsWithIndicators(barsOf(series, 0, series.t.length));
  for (const b of bars) b.atrHour = b.atr;
  return bars;
}

/**
 * The setups the replay would take at the close of the last candle in
 * `series` (just closed, live): the same traders, candles, spacing and cost
 * check as replayTimeframe, so a live trade is one the replay would have
 * taken. Entry, stop and target are in the candles' prices; the regime is
 * the candle's (null without setups). Null with too few candles.
 */
export function latestSlowSetups(
  symbol: string,
  series: CandleSeries,
  tf: Timeframe,
  feeRate: number,
  spreadPct: number = 0
): { regime: RegimeType | null; setups: StrategySetup[] } | null {
  const rules = TIMEFRAME_RULES[tf];
  const n = series.t.length;
  if (n < rules.warmupBars + 1) return null;
  const bars = slowBars(series);
  const last = n - 1;
  // From a month of candles back, so a trader who signalled just before is spaced out, as in the replay.
  const found = panelSetupsOnHistory(symbol, bars, undefined, {
    from: Math.max(rules.warmupBars, last - SPACING_LOOKBACK_BARS),
    view: HISTORY_VIEW_BARS,
    intervalMs: rules.intervalMs,
    higherMs: rules.higherMs,
    anyTime: rules.anyTime,
    throughLast: true,
  });
  const at = found.find((f) => f.i === last);
  if (!at) return { regime: null, setups: [] };
  const setups = at.setups.filter((s) => {
    const risk = Math.abs(s.entryPrice - s.stopLoss);
    return risk > 0 && ((feeRate + spreadPct) * s.entryPrice) / risk <= MAX_COST_SHARE_OF_STOP;
  });
  return { regime: at.regime, setups };
}

// ---------- the coin check: each market on its own, and a fixed list of coins ----------
// The coins replayed are the ones most active today, picked hourly. Those may
// be coins that rose over the two years, which would flatter the traders'
// results. So the replay also covers a list fixed in advance, and keeps each
// market's slower results on their own, so the two can be compared.

/**
 * The 20 biggest coins by market value on 1 Oct 2024, when the two years
 * replayed begin, leaving out stablecoins and coins Binance doesn't list:
 * picked before anyone knew how they'd do.
 */
export const FIXED_COINS = [
  "BTC/INR", "ETH/INR", "BNB/INR", "SOL/INR", "XRP/INR", "DOGE/INR", "TRX/INR", "TON/INR", "ADA/INR", "AVAX/INR",
  "SHIB/INR", "LINK/INR", "BCH/INR", "DOT/INR", "NEAR/INR", "UNI/INR", "LTC/INR", "SUI/INR", "ICP/INR", "PEPE/INR",
];

/** One market's slower results: every trader together, per timeframe and exit profile. */
export type MarketTotals = Partial<Record<Timeframe, Partial<Record<TrailProfileId, TraderRecord>>>>;

/** Records summed over every period and trader, per exit profile. */
export function totalsByProfile(records: HistoryRecords): Partial<Record<TrailProfileId, TraderRecord>> {
  const out: Partial<Record<TrailProfileId, TraderRecord>> = {};
  for (const [profile, byPeriod] of Object.entries(records) as [TrailProfileId, Record<string, Record<string, TraderRecord>>][]) {
    out[profile] = sumRecords(Object.values(byPeriod).flatMap((byKey) => Object.values(byKey)));
  }
  return out;
}

/** A market's slower records as its totals. */
export function marketTotals(slow: Partial<Record<Timeframe, HistoryRecords>>): MarketTotals {
  return Object.fromEntries(TIMEFRAMES.map((tf) => [tf, totalsByProfile(slow[tf] ?? {})]));
}
