import type { ShadowSignal } from "./shadowTracker";
import { marketOf, type MarketKey } from "../shared/marketLimits";

// When setups win: every setup the scanner has followed (taken or not),
// grouped by the conditions it appeared in (market mood, Bitcoin's last
// hour, time of day, volume, trend strength, RSI), with how often it won and
// what it averaged in R after fees and the market's spread. Coins and stocks
// are pooled, with each shown too, so a pattern that holds in both shows up
// sooner, and one that holds in only one market is visible as such.

export interface ConditionCell {
  setups: number;
  /** Share of setups that ended ahead, 0–100. */
  winPct: number;
  /** Average result in R, after fees and the spread. */
  avgR: number;
}

export interface ConditionRow {
  label: string;
  all: ConditionCell;
  coins: ConditionCell;
  /** Indian stocks. */
  stocks: ConditionCell;
  us: ConditionCell;
}

export interface ConditionGroup {
  id: string;
  title: string;
  rows: ConditionRow[];
}

export interface ConditionBreakdown {
  /** Finished setups counted. */
  setups: number;
  /** When the oldest of them appeared (ms), 0 with none. */
  since: number;
  groups: ConditionGroup[];
}

/** Fewer setups than this in a row and it's too early to say. */
export const MIN_CONDITION_SETUPS = 20;

const REGIME_LABEL: Record<string, string> = {
  trending_bullish: "Trending up",
  trending_bearish: "Trending down",
  ranging_tight: "Quiet range",
  ranging_wide: "Wide range",
  high_volatility_choppy: "Choppy",
};

type Bucket = { label: string; test: (s: ShadowSignal) => boolean };

const between = (get: (s: ShadowSignal) => number | undefined, lo: number, hi: number) => (s: ShadowSignal) => {
  const v = get(s);
  return v !== undefined && Number.isFinite(v) && v >= lo && v < hi;
};

/** Hour of the day in India (IST) the setup appeared. */
const istHour = (s: ShadowSignal) => new Date(s.signalTime + 5.5 * 60 * 60 * 1000).getUTCHours();

const GROUPS: { id: string; title: string; buckets: Bucket[] }[] = [
  {
    id: "regime",
    title: "Market mood",
    buckets: Object.entries(REGIME_LABEL).map(([id, label]) => ({ label, test: (s) => s.regime === id })),
  },
  {
    id: "btc",
    title: "Bitcoin's last hour",
    buckets: [
      { label: "Falling (−0.5% or more)", test: between((s) => s.btcChange1hPct, -Infinity, -0.5) },
      { label: "Flat", test: between((s) => s.btcChange1hPct, -0.5, 0.5) },
      { label: "Rising (+0.5% or more)", test: between((s) => s.btcChange1hPct, 0.5, Infinity) },
    ],
  },
  {
    id: "hour",
    title: "Time of day (IST)",
    buckets: [0, 4, 8, 12, 16, 20].map((h) => ({
      label: `${String(h).padStart(2, "0")}:00–${String(h + 4).padStart(2, "0")}:00`,
      test: (s: ShadowSignal) => istHour(s) >= h && istHour(s) < h + 4,
    })),
  },
  {
    id: "volume",
    title: "Volume against normal",
    buckets: [
      { label: "Below normal (under 1×)", test: between((s) => s.setupFeatures?.volumeSurgeRatio, -Infinity, 1) },
      { label: "1–1.5×", test: between((s) => s.setupFeatures?.volumeSurgeRatio, 1, 1.5) },
      { label: "1.5–2.5×", test: between((s) => s.setupFeatures?.volumeSurgeRatio, 1.5, 2.5) },
      { label: "Surge (2.5× or more)", test: between((s) => s.setupFeatures?.volumeSurgeRatio, 2.5, Infinity) },
    ],
  },
  {
    id: "adx",
    title: "Trend strength (ADX)",
    buckets: [
      { label: "Weak (under 20)", test: between((s) => s.setupFeatures?.adx, -Infinity, 20) },
      { label: "Moderate (20–30)", test: between((s) => s.setupFeatures?.adx, 20, 30) },
      { label: "Strong (30 or more)", test: between((s) => s.setupFeatures?.adx, 30, Infinity) },
    ],
  },
  {
    id: "rsi",
    title: "RSI",
    buckets: [
      { label: "Oversold (under 30)", test: between((s) => s.setupFeatures?.rsi, -Infinity, 30) },
      { label: "30–45", test: between((s) => s.setupFeatures?.rsi, 30, 45) },
      { label: "45–55", test: between((s) => s.setupFeatures?.rsi, 45, 55) },
      { label: "55–70", test: between((s) => s.setupFeatures?.rsi, 55, 70) },
      { label: "Overbought (70 or more)", test: between((s) => s.setupFeatures?.rsi, 70, Infinity) },
    ],
  },
];

/**
 * A finished setup's result in R after the spread too (shadow results carry
 * fees only): a round trip pays the spread once, as a share of entry, over
 * the stop distance.
 */
export function resultAfterSpread(s: ShadowSignal, spreadPct: number | undefined): number | null {
  if (s.r === undefined || !Number.isFinite(s.r)) return null;
  const risk = Math.abs(s.entryPrice - s.stopLoss);
  if (!(risk > 0)) return null;
  const spread = spreadPct && spreadPct > 0 ? (spreadPct * s.entryPrice) / risk : 0;
  return s.r - spread;
}

function cell(results: number[]): ConditionCell {
  const n = results.length;
  if (n === 0) return { setups: 0, winPct: 0, avgR: 0 };
  const wins = results.filter((r) => r > 0).length;
  return { setups: n, winPct: Math.round((wins / n) * 100), avgR: results.reduce((a, r) => a + r, 0) / n };
}

/** Finished intraday setups, grouped by condition, for coins and stocks together and each. */
export function conditionBreakdown(shadows: ShadowSignal[], spreadFor: (symbol: string) => number | undefined = () => undefined): ConditionBreakdown {
  const done = shadows
    .filter((s) => s.horizon === "intraday" && s.status !== "open")
    .map((s) => ({ s, r: resultAfterSpread(s, spreadFor(s.symbol)), market: marketOf(s.symbol) }))
    .filter((x): x is { s: ShadowSignal; r: number; market: MarketKey } => x.r !== null);

  const groups = GROUPS.map((g) => ({
    id: g.id,
    title: g.title,
    rows: g.buckets
      .map((b) => {
        const hits = done.filter((x) => b.test(x.s));
        return {
          label: b.label,
          all: cell(hits.map((x) => x.r)),
          coins: cell(hits.filter((x) => x.market === "coins").map((x) => x.r)),
          stocks: cell(hits.filter((x) => x.market === "stocks").map((x) => x.r)),
          us: cell(hits.filter((x) => x.market === "us").map((x) => x.r)),
        };
      })
      .filter((row) => row.all.setups > 0),
  })).filter((g) => g.rows.length > 0);

  return { setups: done.length, since: done.reduce((m, x) => (m === 0 ? x.s.signalTime : Math.min(m, x.s.signalTime)), 0), groups };
}
