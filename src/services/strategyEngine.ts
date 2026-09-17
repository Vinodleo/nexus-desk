import { MarketBar, StrategySetup, RegimeType, StrategyFamily, TradeDirection, PromotedLabModel } from "../types";

export interface CandidateEvaluationContext {
  symbol: string;
  timeframe: string;
  bars: MarketBar[];
  regime: RegimeType;
  eventWindowActive: boolean;
  eventHeadline?: string;
  promotedModel?: PromotedLabModel | null;
}

export function evaluatePredefinedSetups(ctx: CandidateEvaluationContext): StrategySetup[] {
  const { symbol, timeframe, bars, regime, eventWindowActive, promotedModel } = ctx;
  if (bars.length < 5) return [];

  const current = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const price = current.close;

  const ema9 = current.ema9 || price;
  const ema21 = current.ema21 || price;
  const ema50 = current.ema50 || price;
  const vwap = current.vwap || price;
  const rsi = current.rsi || 50;
  const adx = current.adx || 20;
  const atr = current.atr || price * 0.005;

  const avgVol = bars.slice(-10).reduce((acc, b) => acc + b.volume, 0) / 10;
  const volumeSurgeRatio = Number((current.volume / (avgVol || 1)).toFixed(2));
  const vwapDistPercent = Number((((price - vwap) / vwap) * 100).toFixed(2));
  
  // Extract optimized params if available from grid search
  const params = promotedModel?.optimizedParameters;
  const slMultBreakout = params ? params.slMultiplier : 1.2;
  const tpMultBreakout = params ? params.tpMultiplier : 2.5;
  const surgeReqBreakout = params ? params.volSurgeThreshold : 1.25;
  const rsiOversoldThreshold = params ? (100 - params.rsiThreshold) : 32;
  const rsiOverboughtThreshold = params ? params.rsiThreshold : 68;

  const setups: StrategySetup[] = [];

  // Setup A: Trend Following / Momentum
  {
    const isBullTrend = ema9 > ema21 && ema21 > ema50 && price > vwap && adx >= 22;
    const isBearTrend = ema9 < ema21 && ema21 < ema50 && price < vwap && adx >= 22;
    const direction: TradeDirection = isBullTrend ? "LONG" : "SHORT";
    const qualifies = (isBullTrend || isBearTrend) && regime !== "high_volatility_choppy" && !eventWindowActive;

    const stopDistance = Math.max(atr * 1.5, price * 0.004);
    const targetDistance = stopDistance * 3.5;
    const entryPrice = price;
    const stopLoss = Number((direction === "LONG" ? price - stopDistance : price + stopDistance).toFixed(2));
    const takeProfit = Number((direction === "LONG" ? price + targetDistance : price - targetDistance).toFixed(2));

    let disqualificationReason: string | undefined;
    if (regime === "high_volatility_choppy") disqualificationReason = "Regime filter: choppy volatility invalidates momentum";
    else if (eventWindowActive) disqualificationReason = "Event filter: high-impact news blackout active";
    else if (adx < 22) disqualificationReason = "Guardrail: ADX < 22 indicates weak/absent trend";
    else if (!isBullTrend && !isBearTrend) disqualificationReason = "Moving averages not stacked in clear directional alignment";

    setups.push({
      id: `setup-trend-${symbol}`,
      name: "Trend Momentum Continuation",
      family: "trend_following",
      direction,
      symbol,
      timeframe,
      entryPrice,
      stopLoss,
      takeProfit,
      riskRewardRatio: 2.2,
      baseProbability: 0.58,
      qualifies,
      disqualificationReason,
      features: {
        emaAlignment: isBullTrend || isBearTrend,
        volumeSurgeRatio,
        vwapDistancePercent: vwapDistPercent,
        adx,
        rsi,
        atr,
      },
    });
  }

  // Setup B: Breakout With Confirmation
  {
    const recentHigh = Math.max(...bars.slice(-15, -1).map((b) => b.high));
    const recentLow = Math.min(...bars.slice(-15, -1).map((b) => b.low));
    const isBullBreak = price > recentHigh && volumeSurgeRatio >= surgeReqBreakout;
    const isBearBreak = price < recentLow && volumeSurgeRatio >= surgeReqBreakout;
    const direction: TradeDirection = isBullBreak ? "LONG" : isBearBreak ? "SHORT" : (price >= (recentHigh + recentLow) / 2 ? "LONG" : "SHORT");
    const qualifies = (isBullBreak || isBearBreak) && !eventWindowActive;

    const stopDistance = Math.max(atr * slMultBreakout, price * 0.003);
    const targetDistance = Math.max(atr * tpMultBreakout, stopDistance * 2.5);
    const entryPrice = price;
    const stopLoss = Number((direction === "LONG" ? price - stopDistance : price + stopDistance).toFixed(2));
    const takeProfit = Number((direction === "LONG" ? price + targetDistance : price - targetDistance).toFixed(2));

    let disqualificationReason: string | undefined;
    if (eventWindowActive) disqualificationReason = "Event filter active";
    else if (volumeSurgeRatio < surgeReqBreakout) disqualificationReason = `Guardrail: Volume surge ${volumeSurgeRatio}x below ${surgeReqBreakout}x confirmation threshold`;
    else if (!isBullBreak && !isBearBreak) disqualificationReason = "Price within 15-bar range boundaries; no breakout present";

    setups.push({
      id: `setup-breakout-${symbol}`,
      name: "Breakout With Volume Confirmation",
      family: "breakout_confirmation",
      direction,
      symbol,
      timeframe,
      entryPrice,
      stopLoss,
      takeProfit,
      riskRewardRatio: 2.5,
      baseProbability: 0.53,
      qualifies,
      disqualificationReason,
      features: {
        emaAlignment: ema9 > ema21,
        volumeSurgeRatio,
        vwapDistancePercent: vwapDistPercent,
        adx,
        rsi,
        atr,
      },
    });
  }

  // Setup C: Mean Reversion
  {
    const bbUpper = current.bbUpper || price * 1.02;
    const bbLower = current.bbLower || price * 0.98;
    const isRsiOverbought = rsi >= rsiOverboughtThreshold;
    const isRsiOversold = rsi <= rsiOversoldThreshold;
    const isRangeRegime = regime === "ranging_tight" || regime === "ranging_wide";
    const direction: TradeDirection = isRsiOverbought ? "SHORT" : "LONG";
    const qualifies = isRangeRegime && (isRsiOverbought || isRsiOversold) && adx < 26 && !eventWindowActive;

    const stopDistance = Math.max(atr * 1.0, price * 0.0035);
    const targetDistance = Math.abs(price - vwap) * 1.5;
    const entryPrice = price;
    const stopLoss = Number((direction === "LONG" ? price - stopDistance : price + stopDistance).toFixed(2));
    const takeProfit = Number((direction === "LONG" ? price + targetDistance : price - targetDistance).toFixed(2));

    let disqualificationReason: string | undefined;
    if (!isRangeRegime) disqualificationReason = "Guardrail: Mean reversion forbidden during trending or high-volatility regimes";
    else if (adx >= 26) disqualificationReason = "ADX >= 26 indicates developing directional momentum";
    else if (!isRsiOverbought && !isRsiOversold) disqualificationReason = `RSI (${rsi}) in neutral zone (${rsiOversoldThreshold}-${rsiOverboughtThreshold}); deviation too small`;

    setups.push({
      id: `setup-meanrev-${symbol}`,
      name: "Range Mean Reversion",
      family: "mean_reversion",
      direction,
      symbol,
      timeframe,
      entryPrice,
      stopLoss,
      takeProfit,
      riskRewardRatio: targetDistance > 0 ? Number((targetDistance / stopDistance).toFixed(1)) : 1.8,
      baseProbability: 0.61,
      qualifies,
      disqualificationReason,
      features: {
        emaAlignment: false,
        volumeSurgeRatio,
        vwapDistancePercent: vwapDistPercent,
        adx,
        rsi,
        atr,
      },
    });
  }

  return setups;
}
