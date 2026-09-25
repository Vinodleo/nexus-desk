import type { MarketBar, RegimeType } from "../types";
import { panelSetupsOnHistory } from "./labSimulation";
import { decorateBarsWithIndicators } from "./marketDataService";
import { tradesTooRarely } from "./tradingActivity";
import { simulateExit } from "./exitComparison";
import { isNseSymbol } from "../shared/nse";
import { isUsSymbol } from "../shared/usMarket";
import { DEFAULT_TRAIL_PROFILE, type TrailProfileId } from "../shared/trailingStop";

// What each trader's setups actually earn with the live exits. The profit
// check used to assume a winning trade reaches its target; the exits (the
// trailing stop, banking half at +1R, the time limit) close most winners
// well before that, while a loser still costs the whole stop. So a setup
// could look like "2 to 1" and really pay less than it risks.
//
// This plays every setup each trader would have put forward over the
// candles held now (about the last day) forward under the live exit rules,
// after fees and the market's bid-ask spread (a round trip buys at the ask
// and sells at the bid), and records each trader's average result in R. A trader whose
// setups lose money that way doesn't trade until they recover. Coins and
// stocks are measured separately, but judged together: a trader's result in
// one market leans on their record in the other (partial pooling), so a few
// lucky setups in one market can't outweigh a long losing record in the
// other. Recomputed every hour.

export interface TraderRecord {
  trades: number;
  /** Sum of results in R, after fees. */
  totalR: number;
  wins: number;
  /** Sums of the winning and losing results, in R. */
  winR: number;
  lossR: number;
}

export interface ExpectancyTable {
  profile: string;
  measuredAt: number;
  /** Coins/stocks with usable history. */
  symbols: number;
  /** Keyed by expectancyKey (market and trader). */
  byKey: Record<string, TraderRecord>;
}

/** Setups a market needs across all its traders before the table is used for it. */
export const MIN_MARKET_TRADES = 30;
/**
 * A trader's result in a market is judged as if it had this many more setups
 * at their record in the other market (break-even with none there).
 */
const PRIOR_TRADES = 8;
/** A good record in the other market counts for this share: a trader still proves themselves in each market. */
const GOOD_PRIOR_SHARE = 0.5;
/** Recompute this often. */
export const EXPECTANCY_TTL_MS = 60 * 60 * 1000;

export type MarketKind = "crypto" | "nse" | "us";
export const MARKET_KINDS: MarketKind[] = ["crypto", "nse", "us"];
const marketOf = (symbol: string): MarketKind => (isUsSymbol(symbol) ? "us" : isNseSymbol(symbol) ? "nse" : "crypto");

export function expectancyKey(symbol: string, setupName: string): string {
  return `${marketOf(symbol)}:${setupName}`;
}

/** Plays every trader's setups on `sets` forward under the live exits (the given trail profile). */
export function measureExpectancy(
  sets: { symbol: string; bars: MarketBar[] }[],
  profile: TrailProfileId = DEFAULT_TRAIL_PROFILE,
  now: number = Date.now(),
  /** Each market's bid-ask spread (share of price), paid once per trade; unknown ones cost nothing extra. */
  spreadFor: (symbol: string) => number | undefined = () => undefined
): ExpectancyTable {
  const byKey: Record<string, TraderRecord> = {};
  let symbols = 0;
  for (const set of sets) {
    const { symbol } = set;
    if (set.bars.length < 100 || set.bars.some((b) => b.isSynthetic)) continue;
    // Coins that trade too rarely aren't traded, so they don't count toward anyone's record.
    if (tradesTooRarely(set.bars)) continue;
    // The live candles carry the scanner's indicators; add them if these don't.
    const bars = set.bars[set.bars.length - 1].ema21 === undefined ? decorateBarsWithIndicators(set.bars) : set.bars;
    symbols++;
    for (const { i, setups } of panelSetupsOnHistory(symbol, bars)) {
      for (const setup of setups) {
        const result = simulateExit(setup, bars, i, profile, spreadFor(symbol) ?? 0);
        if (!result) continue;
        const key = expectancyKey(symbol, setup.name);
        const rec = (byKey[key] ??= { trades: 0, totalR: 0, wins: 0, winR: 0, lossR: 0 });
        rec.trades++;
        rec.totalR += result.r;
        if (result.r > 0) {
          rec.wins++;
          rec.winR += result.r;
        } else rec.lossR += result.r;
      }
    }
  }
  return { profile, measuredAt: now, symbols, byKey };
}

/** A trader's average result in R, shrunk toward 0 when there are few trades. */
export function shrunkR(rec: TraderRecord | undefined): number {
  if (!rec) return 0;
  return rec.totalR / (rec.trades + PRIOR_TRADES);
}


/**
 * What a trader's record in the other markets says about them here: their
 * (shrunk) average across them, a good one counting for half; 0 with none.
 */
export function crossMarketPrior(table: ExpectancyTable, market: MarketKind, setupName: string): number {
  const others = MARKET_KINDS.filter((m) => m !== market)
    .map((m) => table.byKey[`${m}:${setupName}`])
    .filter((r): r is TraderRecord => !!r && r.trades > 0);
  if (others.length === 0) return 0;
  const pooled = others.reduce((a, r) => ({ ...a, trades: a.trades + r.trades, totalR: a.totalR + r.totalR }), {
    trades: 0, totalR: 0, wins: 0, winR: 0, lossR: 0,
  });
  const r = shrunkR(pooled);
  return r > 0 ? r * GOOD_PRIOR_SHARE : r;
}

/**
 * The result a trader is judged on in a market: their setups there, plus
 * PRIOR_TRADES setups' worth of their record in the other market.
 */
export function judgedR(table: ExpectancyTable, market: MarketKind, setupName: string): number {
  const rec = table.byKey[`${market}:${setupName}`];
  const prior = crossMarketPrior(table, market, setupName);
  return ((rec?.totalR ?? 0) + PRIOR_TRADES * prior) / ((rec?.trades ?? 0) + PRIOR_TRADES);
}

/** Setups measured for a market, across its traders. */
export function marketTrades(table: ExpectancyTable, market: MarketKind): number {
  return Object.entries(table.byKey)
    .filter(([k]) => k.startsWith(`${market}:`))
    .reduce((n, [, r]) => n + r.trades, 0);
}

/**
 * How this trader's setups do with the live exits, or null when the market
 * doesn't have enough measured setups yet to judge (the check then waits).
 */
export function exitEdgeFor(table: ExpectancyTable | undefined, symbol: string, setupName: string): { r: number; trades: number } | null {
  if (!table || marketTrades(table, marketOf(symbol)) < MIN_MARKET_TRADES) return null;
  const rec = table.byKey[expectancyKey(symbol, setupName)];
  return { r: judgedR(table, marketOf(symbol), setupName), trades: rec?.trades ?? 0 };
}

/** Rows for display: each market's traders, best first. */
export function expectancyRows(table: ExpectancyTable) {
  return Object.entries(table.byKey)
    .map(([key, r]) => {
      const [market, ...name] = key.split(":");
      return {
        market: market as MarketKind,
        trader: name.join(":"),
        trades: r.trades,
        winPct: r.trades > 0 ? Math.round((r.wins / r.trades) * 100) : 0,
        avgWinR: r.wins > 0 ? r.winR / r.wins : 0,
        avgLossR: r.trades - r.wins > 0 ? r.lossR / (r.trades - r.wins) : 0,
        avgR: r.trades > 0 ? r.totalR / r.trades : 0,
        judgedR: judgedR(table, market as MarketKind, name.join(":")),
        /** What their record in the other market adds (0 with none there). */
        otherMarketR: crossMarketPrior(table, market as MarketKind, name.join(":")),
      };
    })
    .sort((a, b) => (a.market === b.market ? b.judgedR - a.judgedR : a.market.localeCompare(b.market)));
}

const cache = new Map<string, ExpectancyTable>();
/** How many markets with candles each cached table was measured from. */
const inputs = new Map<string, number>();

/**
 * The table for this trail profile, measured on `symbols`' candles now and
 * reused for EXPECTANCY_TTL_MS.
 */
export function getExpectancyTable(
  symbols: string[],
  getBars: (symbol: string) => MarketBar[] | null | undefined,
  profile: string | undefined,
  now: number = Date.now(),
  spreadFor?: (symbol: string) => number | undefined
): ExpectancyTable {
  const id = (profile ?? DEFAULT_TRAIL_PROFILE) as TrailProfileId;
  const sets = symbols.flatMap((symbol) => {
    const bars = getBars(symbol);
    return bars && bars.length > 0 ? [{ symbol, bars }] : [];
  });
  const held = cache.get(id);
  // Reused for the hour, unless markets gained candles since (stocks loaded
  // after a restart): then measured again straight away.
  if (held && now - held.measuredAt < EXPECTANCY_TTL_MS && now >= held.measuredAt && sets.length <= (inputs.get(id) ?? 0)) return held;
  const table = measureExpectancy(sets, id, now, spreadFor);
  cache.set(id, table);
  inputs.set(id, sets.length);
  return table;
}

/** The last table measured for a profile, if any (for display). */
export function cachedExpectancyTable(profile: string | undefined): ExpectancyTable | undefined {
  return cache.get((profile ?? DEFAULT_TRAIL_PROFILE) as string);
}

/** Test hook. */
export function _clearExpectancyCache(): void {
  cache.clear();
  inputs.clear();
}

// ---------- the market-wide trend (Bitcoin) ----------

export interface MarketTrend {
  /** Bitcoin's 1-hour trend. */
  regime: RegimeType | "neutral";
  /** Bitcoin's change over the last hour of 5-minute candles, in %; null without the candles. */
  change1hPct: number | null;
}

/** Bitcoin falling this much in an hour counts as the market falling, before its 1-hour trend turns. */
export const MARKET_DROP_PCT = -1;

/** Bitcoin's trend from its 5-minute candles and its 1-hour regime. */
export function marketTrendFrom(btcBars: MarketBar[] | null | undefined, regime: RegimeType | "neutral" | undefined): MarketTrend {
  const bars = btcBars ?? [];
  const last = bars[bars.length - 1];
  const hourAgo = bars[bars.length - 13];
  const change1hPct = last && hourAgo && hourAgo.close > 0 ? ((last.close - hourAgo.close) / hourAgo.close) * 100 : null;
  return { regime: regime ?? "neutral", change1hPct };
}

/** Whether coin longs should wait: Bitcoin's 1-hour trend is down, or it just fell sharply. */
export function marketIsFalling(trend: MarketTrend | undefined): boolean {
  if (!trend) return false;
  return trend.regime === "trending_bearish" || (trend.change1hPct !== null && trend.change1hPct <= MARKET_DROP_PCT);
}
