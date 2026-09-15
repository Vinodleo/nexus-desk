import { StrategySetup, RegimeType, MetaLabelScore } from "../types";

export interface MetaModelFeatures {
  setup: StrategySetup;
  regime: RegimeType;
  empiricalWinRate: number;
  sampleCount: number;
  similarityScore: number;
}

// Meta-Labeling confidence scorer (Section 6F)
export function computeMetaLabelScore(input: MetaModelFeatures): MetaLabelScore {
  const { setup, regime, empiricalWinRate, sampleCount, similarityScore } = input;

  // Base confidence begins with empirical win rate from historically similar setups
  let rawConfidence = empiricalWinRate * 0.55 + setup.baseProbability * 0.45;

  // Regime interaction adjustments
  let regimeFit: "optimal" | "acceptable" | "poor" = "acceptable";
  let rationale = "";

  if (setup.family === "trend_following") {
    if (regime === "trending_bullish" || regime === "trending_bearish") {
      regimeFit = "optimal";
      rawConfidence += 0.08;
      rationale = `Optimal regime alignment: ${regime} supports momentum continuation with ADX ${setup.features.adx}.`;
    } else if (regime === "high_volatility_choppy") {
      regimeFit = "poor";
      rawConfidence -= 0.25;
      rationale = `Poor regime fit: choppy volatility increases whipsaw probability for trend setups.`;
    } else {
      regimeFit = "acceptable";
      rationale = `Acceptable regime: range bound market may exhibit brief momentum bursts.`;
    }
  } else if (setup.family === "breakout_confirmation") {
    if (setup.features.volumeSurgeRatio >= 1.4 && regime !== "high_volatility_choppy") {
      regimeFit = "optimal";
      rawConfidence += 0.07;
      rationale = `Strong volume surge (${setup.features.volumeSurgeRatio}x) confirms breakout escape.`;
    } else if (setup.features.volumeSurgeRatio < 1.2) {
      regimeFit = "poor";
      rawConfidence -= 0.18;
      rationale = `Low volume expansion (${setup.features.volumeSurgeRatio}x) poses high false-breakout risk.`;
    }
  } else if (setup.family === "mean_reversion") {
    if (regime === "ranging_tight" || regime === "ranging_wide") {
      regimeFit = "optimal";
      rawConfidence += 0.10;
      rationale = `Range regime confirms bound prices; VWAP deviation (${setup.features.vwapDistancePercent}%) favors reversion.`;
    } else {
      regimeFit = "poor";
      rawConfidence -= 0.28;
      rationale = `Non-ranging regime: high trend hazard overrides mean-reversion expectations.`;
    }
  }

  // Weight by similarity quality
  if (similarityScore < 0.6) {
    rawConfidence *= 0.9;
  }

  // Clamp calibrated probability to realistic bound [0.15, 0.85]
  const calibratedConfidence = Math.min(0.85, Math.max(0.15, Number(rawConfidence.toFixed(3))));

  return {
    setupId: setup.id,
    confidence: calibratedConfidence,
    calibratedWinProbability: calibratedConfidence,
    historicalSampleCount: sampleCount,
    historicalWinRate: empiricalWinRate,
    confidenceRationale: rationale || `Meta-model instance calibrated to ${(calibratedConfidence * 100).toFixed(1)}% probability.`,
    regimeFit,
  };
}
