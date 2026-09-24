import type { ExperienceVector } from "../types";
import { isSeededExperience } from "./dataProvenance";

// Learning metrics measured on real trades only. The seeded starter bank is
// excluded: its outcomes were generated from fixed win probabilities, so any
// "improvement" measured against it is an artefact, not learning.

export const MIN_REAL_TRADES = 10;
const WINDOW = 30;
/** Brier score of a forecaster that always says 50%: the no-skill reference. */
export const COIN_FLIP_BRIER = 0.25;

export interface LearningStats {
  realCount: number;
  seededCount: number;
  /** True once there are enough real trades for the metrics below to mean anything. */
  enough: boolean;
  /** Win rate over all real trades, %. */
  winRatePct: number | null;
  /** Win rate over the earliest real trades (up to 30), %. */
  earlyWinRatePct: number | null;
  /** Win rate over the most recent real trades (up to 30), %. */
  recentWinRatePct: number | null;
  /** How often the model's side of 52% matched the outcome, recent window, %. */
  directionalAccuracyPct: number | null;
  /** Mean squared error of P(Win) vs outcome over real trades (lower is better). */
  brierScore: number | null;
  /** Largest peak-to-trough fall of cumulative real P&L, % of the peak equity. */
  maxDrawdownPct: number | null;
}

const pct = (n: number, d: number) => Number(((n / d) * 100).toFixed(1));

/**
 * @param experiences memory bank, newest first (as the app stores it)
 * @param startingEquity equity the P&L path starts from, for drawdown %
 */
export function computeLearningStats(experiences: ExperienceVector[], startingEquity = 100000): LearningStats {
  const real = experiences.filter((e) => !isSeededExperience(e) && (e.outcome === "WIN" || e.outcome === "LOSS"));
  const seededCount = experiences.filter(isSeededExperience).length;
  const realCount = real.length;
  const enough = realCount >= MIN_REAL_TRADES;

  if (!enough) {
    return {
      realCount,
      seededCount,
      enough,
      winRatePct: null,
      earlyWinRatePct: null,
      recentWinRatePct: null,
      directionalAccuracyPct: null,
      brierScore: null,
      maxDrawdownPct: null,
    };
  }

  const chronological = [...real].reverse();
  const winsIn = (list: ExperienceVector[]) => list.filter((e) => e.outcome === "WIN").length;

  const windowSize = Math.min(WINDOW, Math.floor(realCount / 2));
  const early = chronological.slice(0, windowSize);
  const recent = chronological.slice(-windowSize);

  const directional = recent.filter((e) => ((e.metaConfidence ?? 0.5) >= 0.52) === (e.outcome === "WIN")).length;

  const brier =
    real.reduce((acc, e) => {
      const p = e.metaConfidence ?? 0.5;
      const y = e.outcome === "WIN" ? 1 : 0;
      return acc + (p - y) ** 2;
    }, 0) / realCount;

  let equity = startingEquity;
  let peak = startingEquity;
  let maxDd = 0;
  for (const e of chronological) {
    equity += e.pnl ?? 0;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - equity) / peak);
  }

  return {
    realCount,
    seededCount,
    enough,
    winRatePct: pct(winsIn(real), realCount),
    earlyWinRatePct: pct(winsIn(early), early.length),
    recentWinRatePct: pct(winsIn(recent), recent.length),
    directionalAccuracyPct: pct(directional, recent.length),
    brierScore: Number(brier.toFixed(3)),
    maxDrawdownPct: Number((maxDd * 100).toFixed(2)),
  };
}

export interface WinRateBucket {
  key: string;
  trades: number;
  wins: number;
  winRatePct: number;
}

export interface LearningBreakdowns {
  byFamily: WinRateBucket[];
  byRegime: WinRateBucket[];
  /** Real trades by their post-trade classification (decision quality × outcome). */
  decisions: {
    goodCallGoodResult: number;
    goodCallBadLuck: number;
    badCallLuckyWin: number;
    badCallBadResult: number;
  };
}

function buckets(real: ExperienceVector[], keyOf: (e: ExperienceVector) => string): WinRateBucket[] {
  const map = new Map<string, { trades: number; wins: number }>();
  for (const e of real) {
    const k = keyOf(e);
    const b = map.get(k) ?? { trades: 0, wins: 0 };
    b.trades++;
    if (e.outcome === "WIN") b.wins++;
    map.set(k, b);
  }
  return [...map.entries()]
    .map(([key, b]) => ({ key, ...b, winRatePct: Math.round((b.wins / b.trades) * 100) }))
    .sort((a, b) => b.trades - a.trades || b.winRatePct - a.winRatePct);
}

/** Win rates by strategy family and market regime, real trades only. */
export function computeLearningBreakdowns(experiences: ExperienceVector[]): LearningBreakdowns {
  const real = experiences.filter((e) => !isSeededExperience(e) && (e.outcome === "WIN" || e.outcome === "LOSS"));
  const count = (c: NonNullable<ExperienceVector["postClassification"]>) =>
    real.filter((e) => e.postClassification === c).length;
  return {
    byFamily: buckets(real, (e) => e.family),
    byRegime: buckets(real, (e) => e.regime),
    decisions: {
      goodCallGoodResult: count("good_decision_good_outcome"),
      goodCallBadLuck: count("good_decision_bad_outcome"),
      badCallLuckyWin: count("bad_decision_good_outcome"),
      badCallBadResult: count("bad_decision_bad_outcome"),
    },
  };
}
