import { SETUP_READINGS } from "./historyReplay";
import type { MarketKind } from "./exitExpectancy";
import { MIN_EDGE_R } from "./calibration";

// The machine-learning test: does anything known when a setup comes (its
// readings, the trader, the market, the time) tell the setups that win from
// those that lose, well enough to beat costs? A model learns from the
// replayed setups of the older months (history_setups/), and is judged only
// on the latest months, which it never saw:
//
//   train       the oldest months: the model learns what came before results
//   validation  the next 3 months: when to stop adding trees, and how choosy
//               to be in each market (what share of setups to take)
//   test        the latest 6 months: the verdict, nothing tuned on it
//
// The model is gradient-boosted decision trees, the usual choice for tables
// of numbers: a few hundred small trees, each correcting the ones before it.
// Readings are put into 32 bins each first (quantiles), so a large table fits
// in a few bytes a setup and trains quickly. The picks are then traded one at
// a time per trader and market, as the desk trades, and compared with taking
// every setup.

export const MARKETS: MarketKind[] = ["crypto", "nse", "us"];
export const REGIMES = ["trending_bullish", "trending_bearish", "ranging_tight", "ranging_wide", "high_volatility_choppy", "neutral"];
/** Bins a reading is put into: 0 for missing, then up to BINS − 1 by quantile. */
export const BINS = 32;

/** Plain names for what the model looks at (shown with how much it relied on each). */
export const FEATURE_LABELS: Record<string, string> = {
  minute: "time of day",
  weekday: "day of the week",
  rsi: "RSI",
  adx: "trend strength (ADX)",
  volSurge: "volume against usual",
  vwapDistPct: "distance from VWAP",
  atrPct: "volatility (ATR)",
  stopPct: "stop distance",
  rewardRisk: "target against stop",
  ema9vs21Pct: "short-term trend (EMAs)",
  ema21vs50Pct: "short-term trend (EMAs)",
  vsEma200Pct: "distance from the 200 EMA",
  chg1hPct: "last hour's move",
  chg4hPct: "last 4 hours' move",
  market1hPct: "Bitcoin's or SPY's last hour",
  market: "which market",
  trader: "which trader",
  direction: "long or short",
  regime: "5-minute trend",
  macro: "1-hour trend",
};

export interface Feature {
  /** Its column, or for a yes/no feature, "group:value" (e.g. "trader:Sofia Range Scalp"). */
  name: string;
  /** What it's shown as (FEATURE_LABELS: one per group). */
  group: string;
  flag: boolean;
}

/** What the model reads: the numbers saved with each setup, and yes/no for its market, trader, side and trends. */
export function featureList(traders: string[]): Feature[] {
  const numbers = ["minute", "weekday", ...SETUP_READINGS].map((name) => ({ name, group: name, flag: false }));
  const flags = (group: string, values: string[]) => values.map((v) => ({ name: `${group}:${v}`, group, flag: true }));
  return [
    ...numbers,
    ...flags("market", MARKETS),
    ...flags("direction", ["SHORT"]),
    ...flags("trader", traders),
    ...flags("regime", REGIMES),
    ...flags("macro", REGIMES),
  ];
}

/** A file's lines one at a time (without splitting it all into an array first). */
export function* linesOf(text: string): Generator<string> {
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    yield text.slice(start, end);
    start = end + 1;
  }
}

/** One saved setup, read from its CSV line. */
export interface SetupRow {
  market: MarketKind;
  trader: string;
  /** Which market (symbol) and trader, for trading one at a time. */
  symbolId: number;
  traderId: number;
  entryMs: number;
  /** Result in R under the exit profile judged, and when it closed. */
  r: number;
  exitMs: number;
  /** Each feature's value (NaN when missing; flags 0 or 1). */
  values: Float64Array;
}

const FIVE_MIN = 5 * 60_000;

/**
 * Reads CSV lines (history_setups/ format) for one market into rows with
 * the profile's result; lines without a result there are left out. The same
 * row object (and its values) is reused for every line, so a million lines
 * don't make a million arrays: copy what you keep.
 */
export function* readSetupLines(
  lines: Iterable<string>,
  header: string,
  market: MarketKind,
  symbolId: number,
  features: Feature[],
  traders: string[],
  profile: string
): Generator<SetupRow> {
  const cols = header.split(",");
  const at = (name: string) => cols.indexOf(name);
  const iEntry = at("entryMs");
  const iTrader = at("trader");
  const iDir = at("direction");
  const iRegime = at("regime");
  const iMacro = at("macro");
  const iR = at(`r_${profile}`);
  const iBars = at(`bars_${profile}`);
  if (iR < 0 || iBars < 0) return;
  const numberCols = features.map((f) => (f.flag ? -1 : at(f.name)));
  const traderIds = new Map(traders.map((t, k) => [t, k]));
  const values = new Float64Array(features.length);
  const row: SetupRow = { market, trader: "", symbolId, traderId: 255, entryMs: 0, r: 0, exitMs: 0, values };
  for (const line of lines) {
    if (!line) continue;
    const v = line.split(",");
    if (v[iR] === "" || v[iR] === undefined) continue;
    const r = Number(v[iR]);
    const entryMs = Number(v[iEntry]);
    if (!Number.isFinite(r) || !Number.isFinite(entryMs)) continue;
    const traderId = traderIds.get(v[iTrader]) ?? -1;
    features.forEach((f, k) => {
      if (!f.flag) {
        const raw = v[numberCols[k]];
        values[k] = raw === "" || raw === undefined ? NaN : Number(raw);
        return;
      }
      const value = f.name.slice(f.group.length + 1);
      const actual = f.group === "market" ? market : f.group === "direction" ? v[iDir] : f.group === "trader" ? v[iTrader] : f.group === "regime" ? v[iRegime] : v[iMacro];
      values[k] = actual === value ? 1 : 0;
    });
    row.trader = v[iTrader];
    row.traderId = traderId < 0 ? 255 : traderId;
    row.entryMs = entryMs;
    row.r = r;
    row.exitMs = entryMs + Number(v[iBars] || 0) * FIVE_MIN;
    yield row;
  }
}

/** Each number feature's bin edges, from a sample of its values (missing ones left out). */
export function binEdges(samples: number[][], features: Feature[]): number[][] {
  return features.map((f, k) => {
    if (f.flag) return [0.5];
    const xs = samples.map((s) => s[k]).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    const edges: number[] = [];
    for (let b = 1; b < BINS - 1; b++) {
      const x = xs[Math.floor((b / (BINS - 1)) * xs.length)];
      if (x !== undefined && (edges.length === 0 || x > edges[edges.length - 1])) edges.push(x);
    }
    return edges;
  });
}

/** A value's bin: 0 when missing, else 1 + the number of edges at or below it. */
export function binOf(x: number, edges: number[]): number {
  if (!Number.isFinite(x)) return 0;
  let lo = 0;
  let hi = edges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (edges[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return 1 + lo;
}

/** Setups as the model trains on them: each feature's bins, a byte a setup, plus what trading one at a time needs. */
export interface SetupTable {
  n: number;
  bins: Uint8Array[];
  r: Float32Array;
  entryMs: Float64Array;
  exitMs: Float64Array;
  /** Symbol and trader together: one trade at a time per pair. */
  pair: Uint32Array;
  market: Uint8Array;
}

export function emptyTable(capacity: number, features: number): SetupTable {
  return {
    n: 0,
    bins: Array.from({ length: features }, () => new Uint8Array(capacity)),
    r: new Float32Array(capacity),
    entryMs: new Float64Array(capacity),
    exitMs: new Float64Array(capacity),
    pair: new Uint32Array(capacity),
    market: new Uint8Array(capacity),
  };
}

/** Adds a row (binned) if there's room; false when the table is full. */
export function addRow(t: SetupTable, row: SetupRow, edges: number[][]): boolean {
  if (t.n >= t.r.length) return false;
  const i = t.n++;
  for (let k = 0; k < edges.length; k++) t.bins[k][i] = binOf(row.values[k], edges[k]);
  t.r[i] = row.r;
  t.entryMs[i] = row.entryMs;
  t.exitMs[i] = row.exitMs;
  t.pair[i] = row.symbolId * 256 + row.traderId;
  t.market[i] = MARKETS.indexOf(row.market);
  return true;
}

// ---------- gradient-boosted trees ----------

type TreeNode = { leaf: true; value: number } | { leaf: false; feature: number; bin: number; left: TreeNode; right: TreeNode };

export interface BoostOptions {
  maxTrees: number;
  depth: number;
  learningRate: number;
  /** Setups a leaf needs at least: results are noisy, so leaves stay large. */
  minLeaf: number;
  /** Share of the training setups each tree learns from (a different random share each time). */
  subsample: number;
  /** Stop after this many trees without the validation error improving. */
  patience: number;
}

export const DEFAULT_BOOST: BoostOptions = { maxTrees: 300, depth: 3, learningRate: 0.05, minLeaf: 500, subsample: 0.5, patience: 25 };

/** Results are clipped to this range while learning, so a few outsized ones can't steer it. */
const CLIP_R: [number, number] = [-1.5, 3];

export interface BoostedModel {
  base: number;
  trees: TreeNode[];
  /** How much each feature's splits improved the fit (summed gain). */
  gain: number[];
}

function leafFor(node: TreeNode, bins: Uint8Array[], i: number): number {
  let n = node;
  while (!n.leaf) n = bins[n.feature][i] <= n.bin ? n.left : n.right;
  return n.value;
}

/** The model's expected result for setup `i` of a table. */
export function predict(model: BoostedModel, t: SetupTable, i: number): number {
  let p = model.base;
  for (const tree of model.trees) p += leafFor(tree, t.bins, i);
  return p;
}

/** A seeded random number generator, so a run can be repeated exactly. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * Trains on `train`, watching the error on `valid`; yields after each tree
 * (so a caller can rest) and returns the model cut to its best tree count.
 */
export function* trainBoosted(train: SetupTable, valid: SetupTable, opts: BoostOptions = DEFAULT_BOOST): Generator<number, BoostedModel> {
  const F = train.bins.length;
  const y = Float32Array.from(train.r.subarray(0, train.n), (r) => Math.min(CLIP_R[1], Math.max(CLIP_R[0], r)));
  let base = 0;
  for (let i = 0; i < train.n; i++) base += y[i];
  base /= Math.max(1, train.n);
  const pred = new Float32Array(train.n).fill(base);
  const validPred = new Float32Array(valid.n).fill(base);
  const validY = Float32Array.from(valid.r.subarray(0, valid.n), (r) => Math.min(CLIP_R[1], Math.max(CLIP_R[0], r)));
  const g = new Float32Array(train.n);
  const gain = new Array<number>(F).fill(0);
  const trees: TreeNode[] = [];
  const random = seeded(7);
  const validError = () => {
    let e = 0;
    for (let i = 0; i < valid.n; i++) e += (validPred[i] - validY[i]) ** 2;
    return e / Math.max(1, valid.n);
  };
  let best = { error: validError(), trees: 0 };
  const G = new Float64Array(BINS);
  const C = new Float64Array(BINS);

  const grow = (rows: Uint32Array, depth: number): TreeNode => {
    let sumG = 0;
    for (let k = 0; k < rows.length; k++) sumG += g[rows[k]];
    const leaf = (): TreeNode => ({ leaf: true, value: (-opts.learningRate * sumG) / Math.max(1, rows.length) });
    if (depth >= opts.depth || rows.length < 2 * opts.minLeaf) return leaf();
    const total = rows.length;
    let bestSplit: { feature: number; bin: number; gain: number } | null = null;
    for (let f = 0; f < F; f++) {
      G.fill(0);
      C.fill(0);
      const bf = train.bins[f];
      for (let k = 0; k < rows.length; k++) {
        const b = bf[rows[k]];
        G[b] += g[rows[k]];
        C[b]++;
      }
      let gl = 0;
      let cl = 0;
      for (let b = 0; b < BINS - 1; b++) {
        gl += G[b];
        cl += C[b];
        const cr = total - cl;
        if (cl < opts.minLeaf) continue;
        if (cr < opts.minLeaf) break;
        const gr = sumG - gl;
        const score = (gl * gl) / cl + (gr * gr) / cr - (sumG * sumG) / total;
        if (score > (bestSplit?.gain ?? 1e-9)) bestSplit = { feature: f, bin: b, gain: score };
      }
    }
    if (!bestSplit) return leaf();
    const bf = train.bins[bestSplit.feature];
    let nl = 0;
    for (let k = 0; k < rows.length; k++) if (bf[rows[k]] <= bestSplit.bin) nl++;
    const left = new Uint32Array(nl);
    const right = new Uint32Array(rows.length - nl);
    let a = 0;
    let z = 0;
    for (let k = 0; k < rows.length; k++) {
      if (bf[rows[k]] <= bestSplit.bin) left[a++] = rows[k];
      else right[z++] = rows[k];
    }
    gain[bestSplit.feature] += bestSplit.gain;
    return { leaf: false, feature: bestSplit.feature, bin: bestSplit.bin, left: grow(left, depth + 1), right: grow(right, depth + 1) };
  };

  for (let t = 0; t < opts.maxTrees; t++) {
    for (let i = 0; i < train.n; i++) g[i] = pred[i] - y[i];
    const picked: number[] = [];
    for (let i = 0; i < train.n; i++) if (random() < opts.subsample) picked.push(i);
    const tree = grow(Uint32Array.from(picked), 0);
    trees.push(tree);
    for (let i = 0; i < train.n; i++) pred[i] += leafFor(tree, train.bins, i);
    for (let i = 0; i < valid.n; i++) validPred[i] += leafFor(tree, valid.bins, i);
    const error = validError();
    if (error < best.error - 1e-12) best = { error, trees: trees.length };
    yield trees.length;
    if (trees.length - best.trees >= opts.patience) break;
  }
  return { base, trees: trees.slice(0, best.trees), gain };
}

// ---------- judging the picks ----------

export interface PickStats {
  trades: number;
  wins: number;
  totalR: number;
  /** Sum of squared results, for how sure the average is. */
  sumSq: number;
}

const emptyStats = (): PickStats => ({ trades: 0, wins: 0, totalR: 0, sumSq: 0 });

/**
 * Trades the setups `take` picks one at a time per trader and market, in
 * the order they came, as the desk does, and totals them by market.
 */
export function oneAtATime(t: SetupTable, take: (i: number) => boolean, onlyMarket?: number): Record<MarketKind, PickStats> {
  const order = Array.from({ length: t.n }, (_, i) => i).filter((i) => onlyMarket === undefined || t.market[i] === onlyMarket);
  order.sort((a, b) => t.entryMs[a] - t.entryMs[b]);
  const busy = new Map<number, number>();
  const out = { crypto: emptyStats(), nse: emptyStats(), us: emptyStats() };
  for (const i of order) {
    if (!take(i) || t.entryMs[i] < (busy.get(t.pair[i]) ?? 0)) continue;
    busy.set(t.pair[i], t.exitMs[i]);
    const s = out[MARKETS[t.market[i]]];
    s.trades++;
    s.totalR += t.r[i];
    s.sumSq += t.r[i] * t.r[i];
    if (t.r[i] > 0) s.wins++;
  }
  return out;
}

/** Average result per trade, and the lowest it could plausibly be (two standard errors below). */
export function summary(s: PickStats): { trades: number; winPct: number; avgR: number; lowR: number } {
  if (s.trades === 0) return { trades: 0, winPct: 0, avgR: 0, lowR: 0 };
  const avg = s.totalR / s.trades;
  const variance = Math.max(0, s.sumSq / s.trades - avg * avg);
  return { trades: s.trades, winPct: Math.round((s.wins / s.trades) * 100), avgR: avg, lowR: avg - 2 * Math.sqrt(variance / s.trades) };
}

/** The shares of setups the model may be told to take (its most promising first). */
export const PICK_SHARES = [0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 1];
/** Trades a choice needs in validation to count, and in the test to pass. */
export const MIN_VALID_TRADES = 100;
export const MIN_TEST_TRADES = 200;

export interface MarketVerdict {
  /** Share of setups taken: the model's most promising, chosen on validation. */
  share: number;
  /** In the test months: every setup, and the model's picks (one at a time). */
  everySetup: ReturnType<typeof summary>;
  picks: ReturnType<typeof summary>;
  /** The picks average at least MIN_EDGE_R, plausibly above zero, over enough trades. */
  passed: boolean;
}

/** The prediction above which a market's most promising `share` of setups lie. */
function cutoff(preds: Float32Array, t: SetupTable, market: number, share: number): number {
  const xs: number[] = [];
  for (let i = 0; i < t.n; i++) if (t.market[i] === market) xs.push(preds[i]);
  if (xs.length === 0 || share >= 1) return -Infinity;
  xs.sort((a, b) => b - a);
  return xs[Math.max(0, Math.floor(share * xs.length) - 1)];
}

/**
 * For each market: how choosy to be, picked on validation (the share whose
 * picks' plausible-lowest average is best, over enough trades), then judged
 * on the test months.
 */
export function judge(model: BoostedModel, valid: SetupTable, test: SetupTable): Record<MarketKind, MarketVerdict | null> {
  const predsOf = (t: SetupTable) => Float32Array.from({ length: t.n }, (_, i) => predict(model, t, i));
  const validPreds = predsOf(valid);
  const testPreds = predsOf(test);
  const out = {} as Record<MarketKind, MarketVerdict | null>;
  MARKETS.forEach((market, m) => {
    let chosen: { share: number; low: number } | null = null;
    for (const share of PICK_SHARES) {
      const line = cutoff(validPreds, valid, m, share);
      const s = summary(oneAtATime(valid, (i) => validPreds[i] >= line, m)[market]);
      if (s.trades >= MIN_VALID_TRADES && (!chosen || s.lowR > chosen.low)) chosen = { share, low: s.lowR };
    }
    const everySetup = summary(oneAtATime(test, () => true, m)[market]);
    if (!chosen || everySetup.trades === 0) {
      out[market] = null;
      return;
    }
    const line = cutoff(testPreds, test, m, chosen.share);
    const picks = summary(oneAtATime(test, (i) => testPreds[i] >= line, m)[market]);
    out[market] = { share: chosen.share, everySetup, picks, passed: picks.trades >= MIN_TEST_TRADES && picks.avgR >= MIN_EDGE_R && picks.lowR > 0 };
  });
  return out;
}

/** What the model relied on most, by group, as shares of all its gain. */
export function importance(model: BoostedModel, features: Feature[]): { label: string; share: number }[] {
  const byLabel = new Map<string, number>();
  model.gain.forEach((g, k) => {
    const label = FEATURE_LABELS[features[k].group] ?? features[k].group;
    byLabel.set(label, (byLabel.get(label) ?? 0) + g);
  });
  const total = [...byLabel.values()].reduce((a, b) => a + b, 0);
  return [...byLabel.entries()]
    .filter(([, g]) => g > 0)
    .map(([label, g]) => ({ label, share: total > 0 ? g / total : 0 }))
    .sort((a, b) => b.share - a.share);
}
