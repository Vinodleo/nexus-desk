import type { MarketBar } from "../types";
import { decorateBarsWithIndicators } from "./marketDataService";
import { LAB_INTERVAL_MS, panelSetupsOnHistory } from "./labSimulation";
import { simulateExit } from "./exitComparison";
import { expectancyKey, MARKET_KINDS, type MarketKind, type TraderRecord } from "./exitExpectancy";
import { costsTooBigForStop } from "../shared/tradeCosts";
import type { TrailProfileId } from "../shared/trailingStop";

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
 * Replays a market's history a chunk at a time, yielding the trades found
 * every SLICE_BARS candles (so a caller can pause in between). One trade
 * at a time per trader and exit profile, across chunks; trades still open
 * when the history ends are left out.
 */
export function* replayHistory(
  symbol: string,
  series: CandleSeries,
  profiles: TrailProfileId[],
  /** The market's bid-ask spread, paid once per trade (share of price). */
  spreadPct: number = 0
): Generator<HistoryTrade[]> {
  const n = series.t.length;
  /** When each trader's last trade under each profile closes. */
  const busyUntil = new Map<string, number>();
  const closeMs = (bars: MarketBar[], k: number) => (bars[k].timestampMs as number) + LAB_INTERVAL_MS;
  for (let start = CHUNK_WARMUP_BARS; start < n - 1; start += CHUNK_BARS) {
    const end = Math.min(n - 1, start + CHUNK_BARS);
    const first = start - CHUNK_WARMUP_BARS;
    const bars = decorateBarsWithIndicators(barsOf(series, first, Math.min(n, end + CHUNK_TAIL_BARS)));
    for (let from = start; from < end; from += SLICE_BARS) {
      const trades: HistoryTrade[] = [];
      const found = panelSetupsOnHistory(symbol, bars, undefined, { from: from - first, to: Math.min(end, from + SLICE_BARS) - first, view: HISTORY_VIEW_BARS });
      for (const { i, setups } of found) {
        const entryMs = closeMs(bars, i);
        for (const setup of setups) {
          // Not taken live either: its costs would eat too much of the stop.
          if (costsTooBigForStop(symbol, setup.entryPrice, setup.stopLoss, spreadPct)) continue;
          for (const profile of profiles) {
            const key = `${profile}|${setup.name}`;
            if (entryMs < (busyUntil.get(key) ?? 0)) continue;
            const result = simulateExit(setup, bars, i, profile, spreadPct);
            if (!result || result.open) continue;
            const exitMs = closeMs(bars, result.exitIndex);
            busyUntil.set(key, exitMs);
            trades.push({ trader: setup.name, profile, entryMs, exitMs, r: result.r });
          }
        }
      }
      yield trades;
    }
  }
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
