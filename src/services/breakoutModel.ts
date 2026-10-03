import { type CandleSeries } from "./historyReplay";
import { atr, sma, type ClassicTrade } from "./classicStrategies";
import { MIN_EDGE_R } from "./calibration";
import { addRow, binEdges, emptyTable, predict, summary, trainBoosted, type BoostOptions, type Feature, type PickStats, type SetupRow } from "./setupModel";

// The machine-learning test on breakout 55/20 trades: can a model, from what
// was known at a breakout's close, tell the trades that will pay from those
// that won't, well enough that skipping its least promising half adds profit?
//
// Breakout trades are few (about 500 per market in their replays), too few
// for the big test's train / tune / judge split. So it's judged year by year
// ("walk-forward"): for each year from the fifth on, a model learns from all
// the years before but the last, the last one sets how choosy to be (the
// middle of its predictions), and that year's trades are judged, never seen.
// The years judged are pooled. Breakout wins about a trade in three or four,
// a few of them big; a filter that cuts trades only helps if the ones it cuts
// lose money, so that's what it must show.

/** Bump when the readings change: setups saved with the old ones are left. */
export const BREAKOUT_READINGS_VERSION = 1;

/** What's read at each breakout's close, in plain words. */
export const BREAKOUT_READINGS: { name: string; label: string }[] = [
  { name: "strength", label: "how far above the 55-day high" },
  { name: "atrPct", label: "volatility (ATR)" },
  { name: "rise20", label: "rise over 20 days" },
  { name: "rise90", label: "rise over 90 days" },
  { name: "vs200", label: "distance from the 200-day average" },
  { name: "volume", label: "volume against usual" },
  { name: "dayRange", label: "the day's range" },
  { name: "closeAt", label: "where the day closed in its range" },
  { name: "marketUp", label: "market above its 200-day average" },
  { name: "marketRise", label: "the market's rise over 90 days" },
];

const FEATURES: Feature[] = BREAKOUT_READINGS.map((r) => ({ name: r.name, group: r.name, flag: false }));
const DAY_MS = 24 * 60 * 60 * 1000;
const HIGH_DAYS = 55;

/** A replayed breakout trade with what was known at its entry, and its result (after costs, in R). */
export interface BreakoutSetup {
  symbol: string;
  entryMs: number;
  exitMs: number;
  r: number;
  /** BREAKOUT_READINGS' values, in order (null when missing). */
  x: (number | null)[];
}

/** The market (Bitcoin, or the stocks' index fund) as the readings need it. */
export interface MarketCandles {
  s: CandleSeries;
  avg200: (number | undefined)[];
  index: Map<number, number>;
}

export const marketCandles = (s: CandleSeries): MarketCandles => ({ s, avg200: sma(s.c, 200), index: new Map(s.t.map((t, k) => [t, k])) });

const ratio = (a: number, b: number | undefined) => (b !== undefined && b > 0 ? a / b - 1 : NaN);

/** The readings at day `i`'s close (NaN where there isn't enough history). */
export function breakoutReadings(
  s: CandleSeries,
  i: number,
  range: (number | undefined)[],
  avg200: (number | undefined)[],
  market?: MarketCandles
): number[] {
  const a = range[i] ?? NaN;
  const c = s.c[i];
  const high55 = i >= HIGH_DAYS ? Math.max(...s.h.slice(i - HIGH_DAYS, i)) : NaN;
  const usualVolume = i >= 20 ? s.v.slice(i - 20, i).reduce((x, y) => x + y, 0) / 20 : NaN;
  const j = market?.index.get(s.t[i]);
  const m = market && j !== undefined ? market : null;
  return [
    (c - high55) / a,
    a / c,
    i >= 20 ? ratio(c, s.c[i - 20]) : NaN,
    i >= 90 ? ratio(c, s.c[i - 90]) : NaN,
    ratio(c, avg200[i]),
    usualVolume > 0 ? s.v[i] / usualVolume : NaN,
    (s.h[i] - s.l[i]) / a,
    s.h[i] > s.l[i] ? (c - s.l[i]) / (s.h[i] - s.l[i]) : NaN,
    m && m.avg200[j!] !== undefined ? (m.s.c[j!] > m.avg200[j!]! ? 1 : 0) : NaN,
    m && j! >= 90 ? ratio(m.s.c[j!], m.s.c[j! - 90]) : NaN,
  ].map((x) => (Number.isFinite(x) ? x : NaN));
}

/**
 * Breakout 55/20's replayed trades on one coin's or stock's daily candles
 * (breakoutTrades), each with its readings at entry. Trades still open when
 * the candles end are left out: their result isn't known.
 */
export function breakoutSetups(s: CandleSeries, trades: ClassicTrade[], market?: MarketCandles): BreakoutSetup[] {
  const range = atr(s);
  const avg200 = sma(s.c, 200);
  const index = new Map(s.t.map((t, k) => [t, k]));
  return trades.flatMap((t) => {
    if (t.strategy !== "breakout") return [];
    // A trade enters at a day's close: the candle that started a day before.
    const i = index.get(t.entryMs - DAY_MS);
    if (t.open || i === undefined) return [];
    const x = breakoutReadings(s, i, range, avg200, market).map((v) => (Number.isFinite(v) ? Number(v.toPrecision(6)) : null));
    return [{ symbol: t.symbol, entryMs: t.entryMs, exitMs: t.exitMs, r: Number(t.r.toFixed(4)), x }];
  });
}

/** Small data: shallow trees, small leaves, stopped early on the year before the one judged. */
export const BREAKOUT_BOOST: BoostOptions = { maxTrees: 200, depth: 2, learningRate: 0.05, minLeaf: 15, subsample: 0.7, patience: 20 };
/** Years a model learns from at least, before the year that sets how choosy it is. */
export const MIN_TRAIN_YEARS = 3;
/** Picks the years judged need at least, all together, for a verdict. */
export const MIN_BREAKOUT_PICKS = 50;

type Summary = ReturnType<typeof summary>;

export interface BreakoutMlVerdict {
  /** The years judged (each by a model that never saw it), first and last. */
  fromYear: number;
  toYear: number;
  /** Over the years judged: every trade, the model's picks (its more promising half), and the trades it would skip. */
  every: Summary;
  picks: Summary;
  skipped: Summary;
  /** Each year judged: every trade's average and its picks'. */
  years: { year: number; every: Summary; picks: Summary }[];
  /** What it relied on most. */
  importance: { label: string; share: number }[];
  /** The trades it skips clearly lost (below zero by more than luck), its picks ahead of every trade, over enough picks. */
  passed: boolean;
}

const yearOf = (ms: number) => new Date(ms).getUTCFullYear();
const add = (s: PickStats, r: number) => {
  s.trades++;
  s.totalR += r;
  s.sumSq += r * r;
  if (r > 0) s.wins++;
};
const stats = (): PickStats => ({ trades: 0, wins: 0, totalR: 0, sumSq: 0 });

function tableOf(setups: BreakoutSetup[], edges: number[][]) {
  const t = emptyTable(setups.length, FEATURES.length);
  const values = new Float64Array(FEATURES.length);
  const row: SetupRow = { market: "crypto", trader: "", symbolId: 0, traderId: 0, entryMs: 0, r: 0, exitMs: 0, values };
  for (const s of setups) {
    s.x.forEach((v, k) => (values[k] = v ?? NaN));
    row.entryMs = s.entryMs;
    row.exitMs = s.exitMs;
    row.r = s.r;
    addRow(t, row, edges);
  }
  return t;
}

/** The highest an average could plausibly be: two standard errors above it. */
export const highR = (s: Summary) => (s.trades > 0 ? 2 * s.avgR - s.lowR : 0);

/**
 * The walk-forward test (see above) on one market's breakout setups; null
 * with too few years to judge any.
 */
export function walkForward(setups: BreakoutSetup[], opts: BoostOptions = BREAKOUT_BOOST): BreakoutMlVerdict | null {
  const byYear = new Map<number, BreakoutSetup[]>();
  for (const s of setups) byYear.set(yearOf(s.entryMs), [...(byYear.get(yearOf(s.entryMs)) ?? []), s]);
  const years = [...byYear.keys()].sort((a, b) => a - b);
  if (years.length < MIN_TRAIN_YEARS + 2) return null;

  const every = stats();
  const picks = stats();
  const skipped = stats();
  const perYear: BreakoutMlVerdict["years"] = [];
  const gain = new Array<number>(FEATURES.length).fill(0);
  for (let k = MIN_TRAIN_YEARS + 1; k < years.length; k++) {
    const train = years.slice(0, k - 1).flatMap((y) => byYear.get(y)!);
    const valid = byYear.get(years[k - 1])!;
    const test = byYear.get(years[k])!;
    const edges = binEdges(
      train.map((s) => s.x.map((v) => v ?? NaN)),
      FEATURES
    );
    const tables = { train: tableOf(train, edges), valid: tableOf(valid, edges), test: tableOf(test, edges) };
    const training = trainBoosted(tables.train, tables.valid, opts);
    let step = training.next();
    while (!step.done) step = training.next();
    const model = step.value;
    model.gain.forEach((g, f) => (gain[f] += g));
    // How choosy: the middle of the year before's predictions, known before the year judged starts.
    const validPreds = Array.from({ length: tables.valid.n }, (_, i) => predict(model, tables.valid, i)).sort((a, b) => a - b);
    const line = validPreds[Math.floor(validPreds.length / 2)] ?? -Infinity;
    const yearEvery = stats();
    const yearPicks = stats();
    for (let i = 0; i < tables.test.n; i++) {
      const r = tables.test.r[i];
      add(every, r);
      add(yearEvery, r);
      if (predict(model, tables.test, i) >= line) {
        add(picks, r);
        add(yearPicks, r);
      } else add(skipped, r);
    }
    perYear.push({ year: years[k], every: summary(yearEvery), picks: summary(yearPicks) });
  }
  const totalGain = gain.reduce((a, b) => a + b, 0);
  const everyS = summary(every);
  const picksS = summary(picks);
  const skippedS = summary(skipped);
  return {
    fromYear: years[MIN_TRAIN_YEARS + 1],
    toYear: years[years.length - 1],
    every: everyS,
    picks: picksS,
    skipped: skippedS,
    years: perYear,
    importance: BREAKOUT_READINGS.map((r, f) => ({ label: r.label, share: totalGain > 0 ? gain[f] / totalGain : 0 }))
      .filter((x) => x.share > 0)
      .sort((a, b) => b.share - a.share)
      .slice(0, 5),
    passed: picksS.trades >= MIN_BREAKOUT_PICKS && skippedS.trades > 0 && highR(skippedS) < 0 && picksS.avgR >= everyS.avgR + MIN_EDGE_R,
  };
}
