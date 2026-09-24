import type { ShadowSignal } from "./shadowTracker";

// Win-chance calibration. The scanner's confidence score is built from rules
// of thumb, so "62%" isn't a measured chance of anything. Shadow tracking
// records every setup's score and what then happened on real candles; this
// turns that into the win chance actually seen at each score.
//
// A "win" is scored the way the profit check uses it: a trade that reaches
// its target counts 1, one that stops out counts 0, and one closed at the
// time limit counts in between by how far it got. That makes the measured
// chance, put into the profit check, reproduce the average result seen.

/** The live desk's default bar for the raw confidence score, used until chances are measured. */
export const DEFAULT_MIN_CONFIDENCE = 0.58;
/** With measured win chances, a trade must expect at least this share of its risk back after costs. */
export const MIN_EDGE_R = 0.05;
/**
 * Version of the rule-based score (computeMetaLabelScore). Version 2 leans on
 * each trader's own estimate until real results of similar setups exist,
 * instead of a memory of generated trades. Scores from another version mean
 * something different, so calibration only uses setups scored with this one.
 */
export const HEURISTIC_SCORE_VERSION = 2;
/** Resolved setups needed before measured chances replace the built-in estimate. */
export const MIN_CALIBRATION_SAMPLES = 40;
/** Each band starts as if it had this many setups at its own score, so thin bands stay close to it. */
const PRIOR_WEIGHT = 10;
const BAND_EDGES = [0, 0.3, 0.4, 0.5, 0.6, 0.7, 1];

export type ConfidenceScorer = "heuristic" | "tfjs";

export interface CalibrationBand {
  lo: number;
  hi: number;
  /** Resolved setups whose score fell in this band. */
  samples: number;
  /** Average score of those setups (the band's middle when empty). */
  meanScore: number;
  /** Measured win chance before smoothing, or null when empty. */
  observed: number | null;
  /** Win chance used for this band: smoothed and kept rising with the score. */
  calibrated: number;
}

export interface Calibrator {
  ready: boolean;
  samples: number;
  bands: CalibrationBand[];
  /** Measured win chance for a score; the score itself until ready. */
  calibrate(score: number): number;
}

/**
 * A resolved setup's outcome on the 0-1 win scale, before fees (the profit
 * check charges fees separately). Null while open or if it can't be scored.
 */
export function outcomeScore(s: ShadowSignal): number | null {
  if (s.status === "open" || s.exitPrice === undefined) return null;
  const risk = Math.abs(s.entryPrice - s.stopLoss);
  const reward = Math.abs(s.takeProfit - s.entryPrice);
  if (risk <= 0 || reward <= 0) return null;
  const move = s.direction === "LONG" ? s.exitPrice - s.entryPrice : s.entryPrice - s.exitPrice;
  const r = move / risk;
  const rr = reward / risk;
  return Math.min(1, Math.max(0, (r + 1) / (rr + 1)));
}

/** Pool-adjacent-violators: the closest non-decreasing sequence, weighted. */
function nonDecreasing(values: number[], weights: number[]): number[] {
  const blocks: { value: number; weight: number; count: number }[] = [];
  values.forEach((v, i) => {
    blocks.push({ value: v, weight: weights[i], count: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].value > blocks[blocks.length - 1].value) {
      const b = blocks.pop()!;
      const a = blocks.pop()!;
      const weight = a.weight + b.weight;
      blocks.push({ value: (a.value * a.weight + b.value * b.weight) / weight, weight, count: a.count + b.count });
    }
  });
  return blocks.flatMap((b) => Array(b.count).fill(b.value));
}

/**
 * Builds the calibrator from shadow-tracked setups: intraday ones scored by
 * `scorer` (a Lab-trained model's scores mean something different, so they're
 * calibrated separately).
 */
export function buildCalibrator(
  shadows: ShadowSignal[],
  scorer: ConfidenceScorer = "heuristic",
  minSamples: number = MIN_CALIBRATION_SAMPLES
): Calibrator {
  const points: { score: number; y: number }[] = [];
  for (const s of shadows) {
    if (s.horizon !== "intraday" || s.confidence === undefined) continue;
    if ((s.scorer ?? "heuristic") !== scorer) continue;
    if (scorer === "heuristic" && s.scoreVersion !== HEURISTIC_SCORE_VERSION) continue;
    const y = outcomeScore(s);
    if (y !== null) points.push({ score: s.confidence, y });
  }

  const raw = BAND_EDGES.slice(0, -1).map((lo, i) => {
    const hi = BAND_EDGES[i + 1];
    const inBand = points.filter((p) => p.score >= lo && (p.score < hi || (hi === 1 && p.score <= 1)));
    const n = inBand.length;
    const meanScore = n > 0 ? inBand.reduce((a, p) => a + p.score, 0) / n : (lo + hi) / 2;
    const sumY = inBand.reduce((a, p) => a + p.y, 0);
    return {
      lo,
      hi,
      samples: n,
      meanScore,
      observed: n > 0 ? sumY / n : null,
      smoothed: (sumY + PRIOR_WEIGHT * meanScore) / (n + PRIOR_WEIGHT),
    };
  });
  const monotone = nonDecreasing(
    raw.map((b) => b.smoothed),
    raw.map((b) => b.samples + PRIOR_WEIGHT)
  );
  const bands: CalibrationBand[] = raw.map((b, i) => ({
    lo: b.lo,
    hi: b.hi,
    samples: b.samples,
    meanScore: b.meanScore,
    observed: b.observed,
    calibrated: monotone[i],
  }));

  const ready = points.length >= minSamples;
  const calibrate = (score: number): number => {
    if (!ready) return score;
    // Straight lines between band averages; flat beyond the ends.
    if (score <= bands[0].meanScore) return bands[0].calibrated;
    for (let i = 1; i < bands.length; i++) {
      const a = bands[i - 1];
      const b = bands[i];
      if (score <= b.meanScore) {
        const span = b.meanScore - a.meanScore;
        const t = span > 0 ? (score - a.meanScore) / span : 1;
        return a.calibrated + t * (b.calibrated - a.calibrated);
      }
    }
    return bands[bands.length - 1].calibrated;
  };

  return { ready, samples: points.length, bands, calibrate };
}
