import { ExperienceVector, StrategySetup, RegimeType, TradeAutopsy } from "../types";

// Seed historical experiences
export function generateInitialExperienceDatabase(): ExperienceVector[] {
  const experiences: ExperienceVector[] = [];
  const families = ["trend_following", "breakout_confirmation", "mean_reversion"] as const;
  const regimes: RegimeType[] = ["trending_bullish", "trending_bearish", "ranging_tight", "ranging_wide", "high_volatility_choppy"];
  const symbols = ["NIFTY", "BTC/USDT", "SPY", "ETH/USDT"];

  for (let i = 0; i < 420; i++) {
    const family = families[i % families.length];
    const regime = regimes[i % regimes.length];
    const symbol = symbols[i % symbols.length];

    const adx = 15 + Math.random() * 35;
    const rsi = 25 + Math.random() * 50;
    const volatilityRatio = 0.6 + Math.random() * 1.8;
    const volumeSurgeRatio = 0.8 + Math.random() * 1.6;
    const vwapDist = -2.5 + Math.random() * 5.0;

    // Logical outcome probability based on setup + regime alignment
    let winProb = 0.5;
    if (family === "trend_following") {
      winProb = (regime === "trending_bullish" || regime === "trending_bearish") ? 0.65 : 0.38;
    } else if (family === "breakout_confirmation") {
      winProb = volumeSurgeRatio > 1.3 && volatilityRatio < 1.8 ? 0.61 : 0.40;
    } else if (family === "mean_reversion") {
      winProb = (regime === "ranging_tight" || regime === "ranging_wide") ? 0.67 : 0.35;
    }

    const isWin = Math.random() < winProb;
    const pnl = isWin ? Math.round(150 + Math.random() * 450) : -Math.round(100 + Math.random() * 220);
    const pnlPercent = isWin ? Number((1.2 + Math.random() * 2.8).toFixed(2)) : -Number((0.8 + Math.random() * 1.2).toFixed(2));

    let postClassification: ExperienceVector["postClassification"];
    if (isWin) {
      postClassification = winProb >= 0.5 ? "good_decision_good_outcome" : "bad_decision_good_outcome";
    } else {
      postClassification = winProb >= 0.5 ? "good_decision_bad_outcome" : "bad_decision_bad_outcome";
    }

    const date = new Date(Date.now() - (420 - i) * 3600 * 1000 * 4);

    experiences.push({
      id: `exp-${i + 1}`,
      timestamp: date.toISOString(),
      symbol,
      setupName: family === "trend_following" ? "Trend Momentum Continuation" : family === "breakout_confirmation" ? "Breakout With Confirmation" : "Range Mean Reversion",
      family,
      regime,
      features: {
        adx: Number(adx.toFixed(1)),
        rsi: Number(rsi.toFixed(1)),
        volatilityRatio: Number(volatilityRatio.toFixed(2)),
        volumeSurgeRatio: Number(volumeSurgeRatio.toFixed(2)),
        vwapDist: Number(vwapDist.toFixed(2)),
      },
      metaConfidence: Number(winProb.toFixed(2)),
      decision: "TRADE",
      outcome: isWin ? "WIN" : "LOSS",
      pnl,
      pnlPercent,
      postClassification,
      tags: [regime, family, isWin ? "win" : "loss", `pnl_${isWin ? "pos" : "neg"}`],
    });
  }

  return experiences;
}

// Distance metric for finding top-k similar historical setups
export function retrieveSimilarExperiences(
  setup: StrategySetup,
  regime: RegimeType,
  database: ExperienceVector[],
  k = 15
): {
  neighbors: ExperienceVector[];
  empiricalWinRate: number;
  avgWinDollars: number;
  avgLossDollars: number;
  sampleCount: number;
  similarityScore: number;
} {
  const targetFeatures = {
    adx: setup.features.adx,
    rsi: setup.features.rsi,
    volatilityRatio: 1.0,
    volumeSurgeRatio: setup.features.volumeSurgeRatio,
    vwapDist: setup.features.vwapDistancePercent,
  };

  // Filter or prioritize matching family & symbol
  const scored = database
    .filter((e) => e.family === setup.family)
    .map((item) => {
      // Euclidean distance in normalized feature space
      const dAdx = (item.features.adx - targetFeatures.adx) / 30;
      const dRsi = (item.features.rsi - targetFeatures.rsi) / 40;
      const dVol = (item.features.volumeSurgeRatio - targetFeatures.volumeSurgeRatio) / 1.5;
      const dVwap = (item.features.vwapDist - targetFeatures.vwapDist) / 3.0;
      const dRegime = item.regime === regime ? 0 : 0.8;

      const distance = Math.sqrt(dAdx * dAdx + dRsi * dRsi + dVol * dVol + dVwap * dVwap + dRegime * dRegime);
      const similarity = Math.max(0, 1 / (1 + distance));
      return { item, similarity };
    });

  scored.sort((a, b) => b.similarity - a.similarity);
  const topK = scored.slice(0, k);

  const wins = topK.filter((s) => s.item.outcome === "WIN");
  const losses = topK.filter((s) => s.item.outcome === "LOSS");

  const winPnlSum = wins.reduce((acc, w) => acc + (w.item.pnl || 0), 0);
  const lossPnlSum = losses.reduce((acc, l) => acc + Math.abs(l.item.pnl || 0), 0);

  const empiricalWinRate = topK.length > 0 ? wins.length / topK.length : 0.5;
  const avgWinDollars = wins.length > 0 ? winPnlSum / wins.length : 250;
  const avgLossDollars = losses.length > 0 ? lossPnlSum / losses.length : 150;
  const avgSimilarity = topK.length > 0 ? topK.reduce((acc, s) => acc + s.similarity, 0) / topK.length : 0.8;

  return {
    neighbors: topK.map((s) => s.item),
    empiricalWinRate: Number(empiricalWinRate.toFixed(3)),
    avgWinDollars: Number(avgWinDollars.toFixed(2)),
    avgLossDollars: Number(avgLossDollars.toFixed(2)),
    sampleCount: topK.length,
    similarityScore: Number(avgSimilarity.toFixed(2)),
  };
}
