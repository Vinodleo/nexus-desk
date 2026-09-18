import { MarketBar, StrategySetup, RegimeType, StrategyFamily, TradeDirection, PromotedLabModel } from "../types";

export interface CandidateEvaluationContext {
  symbol: string;
  timeframe: string;
  bars: MarketBar[];
  regime: RegimeType;
  eventWindowActive: boolean;
  eventHeadline?: string;
  promotedModel?: PromotedLabModel | null;
  /** Optional higher-timeframe / broad-index regime, for macro-aware personas. Defaults to neutral when omitted. */
  macroRegime?: RegimeType | "neutral";
}

// Shared, derived indicator snapshot every builder works from.
interface IndicatorSnapshot {
  price: number;
  ema9: number;
  ema21: number;
  ema50: number;
  ema200: number;
  vwap: number;
  rsi: number;
  adx: number;
  atr: number;
  bbUpper: number;
  bbLower: number;
  volumeSurgeRatio: number;
  vwapDistPercent: number;
  recentHigh: number;
  recentLow: number;
}

function deriveSnapshot(bars: MarketBar[]): IndicatorSnapshot | null {
  if (bars.length < 5) return null;
  const current = bars[bars.length - 1];
  const price = current.close;
  const ema9 = current.ema9 || price;
  const ema21 = current.ema21 || price;
  const ema50 = current.ema50 || price;
  const ema200 = current.ema200 || price;
  const vwap = current.vwap || price;
  const rsi = current.rsi || 50;
  const adx = current.adx || 20;
  const atr = current.atr || price * 0.005;
  const bbUpper = current.bbUpper || price * 1.02;
  const bbLower = current.bbLower || price * 0.98;
  const avgVol = bars.slice(-10).reduce((acc, b) => acc + b.volume, 0) / 10;
  const volumeSurgeRatio = Number((current.volume / (avgVol || 1)).toFixed(2));
  const vwapDistPercent = Number((((price - vwap) / vwap) * 100).toFixed(2));
  const recentHigh = Math.max(...bars.slice(-15, -1).map((b) => b.high));
  const recentLow = Math.min(...bars.slice(-15, -1).map((b) => b.low));
  return { price, ema9, ema21, ema50, ema200, vwap, rsi, adx, atr, bbUpper, bbLower, volumeSurgeRatio, vwapDistPercent, recentHigh, recentLow };
}

function baseFeatures(s: IndicatorSnapshot, emaAlignment: boolean) {
  return {
    emaAlignment,
    volumeSurgeRatio: s.volumeSurgeRatio,
    vwapDistancePercent: s.vwapDistPercent,
    adx: s.adx,
    rsi: s.rsi,
    atr: s.atr,
  };
}

// ---------------------------------------------------------------------------
// Setup: Macro Trend Following (Long-term)
// ---------------------------------------------------------------------------

export interface MacroTrendTuning {
  idSuffix: string;
  name: string;
  minAdx: number;
  stopAtrMult: number; // very wide stop
  stopPriceFloorPct: number;
  targetMult: number; // massive target
  baseProbability: number; // typically lower win rate, high R:R
}

export function buildMacroTrendSetup(ctx: CandidateEvaluationContext, tuning: MacroTrendTuning): StrategySetup | null {
  const { symbol, timeframe, bars, regime, eventWindowActive } = ctx;
  const s = deriveSnapshot(bars);
  if (!s) return null;

  // Macro looks at the 50 and 200 EMAs instead of the fast ones
  const isBullTrend = s.price > s.ema50 && s.ema50 > s.ema200 && s.adx >= tuning.minAdx;
  const isBearTrend = s.price < s.ema50 && s.ema50 < s.ema200 && s.adx >= tuning.minAdx;

  const direction: TradeDirection = isBullTrend ? "LONG" : "SHORT";
  const qualifies = (isBullTrend || isBearTrend) && regime !== "high_volatility_choppy" && !eventWindowActive;

  const stopDistance = Math.max(s.atr * tuning.stopAtrMult, s.price * tuning.stopPriceFloorPct);
  const targetDistance = stopDistance * tuning.targetMult;

  const entryPrice = s.price;
  const stopLoss = Number((direction === "LONG" ? s.price - stopDistance : s.price + stopDistance).toFixed(2));
  const takeProfit = Number((direction === "LONG" ? s.price + targetDistance : s.price - targetDistance).toFixed(2));

  let disqualificationReason: string | undefined;
  if (regime === "high_volatility_choppy")
    disqualificationReason = "Regime filter: choppy volatility invalidates macro trend";
  else if (eventWindowActive)
    disqualificationReason = "News filter: approaching major macro binary event";
  else if (!isBullTrend && !isBearTrend)
    disqualificationReason = `Macro trend alignment failed: Price vs 50/200 EMA structure unclear or ADX < ${tuning.minAdx}.`;

  return {
    id: `setup-${tuning.idSuffix}-${symbol}`,
    name: tuning.name,
    family: "trend_following",
    direction,
    symbol,
    timeframe,
    entryPrice,
    stopLoss,
    takeProfit,
    riskRewardRatio: tuning.targetMult,
    baseProbability: tuning.baseProbability,
    qualifies,
    disqualificationReason,
    features: baseFeatures(s, isBullTrend || isBearTrend),
  };
}

// ---------------------------------------------------------------------------
// Setup A family: Trend Following / Momentum
// ---------------------------------------------------------------------------

export interface TrendTuning {
  idSuffix: string;
  name: string;
  minAdx: number;
  stopAtrMult: number;
  stopPriceFloorPct: number;
  targetMult: number; // multiple of stop distance
  baseProbability: number;
}

export const DEFAULT_TREND_TUNING: TrendTuning = {
  idSuffix: "trend",
  name: "Trend Momentum Continuation",
  minAdx: 22,
  stopAtrMult: 1.5,
  stopPriceFloorPct: 0.004,
  targetMult: 2.2,
  baseProbability: 0.58,
};

export function buildTrendSetup(ctx: CandidateEvaluationContext, tuning: TrendTuning = DEFAULT_TREND_TUNING): StrategySetup | null {
  const { symbol, timeframe, bars, regime, eventWindowActive } = ctx;
  const s = deriveSnapshot(bars);
  if (!s) return null;

  const isBullTrend = s.ema9 > s.ema21 && s.ema21 > s.ema50 && s.price > s.vwap && s.adx >= tuning.minAdx;
  const isBearTrend = s.ema9 < s.ema21 && s.ema21 < s.ema50 && s.price < s.vwap && s.adx >= tuning.minAdx;

  const direction: TradeDirection = isBullTrend ? "LONG" : "SHORT";
  const qualifies = (isBullTrend || isBearTrend) && regime !== "high_volatility_choppy" && !eventWindowActive;

  const stopDistance = Math.max(s.atr * tuning.stopAtrMult, s.price * tuning.stopPriceFloorPct);
  const targetDistance = stopDistance * tuning.targetMult;
  const entryPrice = s.price;
  const stopLoss = Number((direction === "LONG" ? s.price - stopDistance : s.price + stopDistance).toFixed(2));
  const takeProfit = Number((direction === "LONG" ? s.price + targetDistance : s.price - targetDistance).toFixed(2));

  let disqualificationReason: string | undefined;
  if (regime === "high_volatility_choppy")
    disqualificationReason = "Regime filter: choppy volatility invalidates momentum";
  else if (eventWindowActive)
    disqualificationReason = "Event filter: high-impact news blackout active";
  else if (s.adx < tuning.minAdx)
    disqualificationReason = `Guardrail: ADX < ${tuning.minAdx} indicates weak/absent trend`;
  else if (!isBullTrend && !isBearTrend)
    disqualificationReason = "Moving averages not stacked in clear directional alignment";

  return {
    id: `setup-${tuning.idSuffix}-${symbol}`,
    name: tuning.name,
    family: "trend_following",
    direction,
    symbol,
    timeframe,
    entryPrice,
    stopLoss,
    takeProfit,
    riskRewardRatio: tuning.targetMult,
    baseProbability: tuning.baseProbability,
    qualifies,
    disqualificationReason,
    features: baseFeatures(s, isBullTrend || isBearTrend),
  };
}

// ---------------------------------------------------------------------------
// Setup B family: Breakout With Volume Confirmation
// ---------------------------------------------------------------------------

export interface BreakoutTuning {
  idSuffix: string;
  name: string;
  volSurgeThreshold: number;
  stopAtrMult: number;
  stopPriceFloorPct: number;
  targetAtrMult: number;
  targetStopMultFloor: number;
  baseProbability: number;
}

export const DEFAULT_BREAKOUT_TUNING = (promotedModel?: PromotedLabModel | null): BreakoutTuning => {
  const params = promotedModel?.optimizedParameters;
  return {
    idSuffix: "breakout",
    name: "Breakout With Volume Confirmation",
    volSurgeThreshold: params ? params.volSurgeThreshold : 1.25,
    stopAtrMult: params ? params.slMultiplier : 1.2,
    stopPriceFloorPct: 0.003,
    targetAtrMult: params ? params.tpMultiplier : 2.5,
    targetStopMultFloor: 1.5,
    baseProbability: 0.53,
  };
};

export function buildBreakoutSetup(ctx: CandidateEvaluationContext, tuning: BreakoutTuning): StrategySetup | null {
  const { symbol, timeframe, bars, eventWindowActive } = ctx;
  const s = deriveSnapshot(bars);
  if (!s) return null;

  const isBullBreak = s.price > s.recentHigh && s.volumeSurgeRatio >= tuning.volSurgeThreshold;
  const isBearBreak = s.price < s.recentLow && s.volumeSurgeRatio >= tuning.volSurgeThreshold;
  const direction: TradeDirection = isBullBreak ? "LONG" : isBearBreak ? "SHORT" : (s.price >= (s.recentHigh + s.recentLow) / 2 ? "LONG" : "SHORT");
  const qualifies = (isBullBreak || isBearBreak) && !eventWindowActive;

  const stopDistance = Math.max(s.atr * tuning.stopAtrMult, s.price * tuning.stopPriceFloorPct);
  const targetDistance = Math.max(s.atr * tuning.targetAtrMult, stopDistance * tuning.targetStopMultFloor);
  const entryPrice = s.price;
  const stopLoss = Number((direction === "LONG" ? s.price - stopDistance : s.price + stopDistance).toFixed(2));
  const takeProfit = Number((direction === "LONG" ? s.price + targetDistance : s.price - targetDistance).toFixed(2));

  let disqualificationReason: string | undefined;
  if (eventWindowActive)
    disqualificationReason = "Event filter active";
  else if (s.volumeSurgeRatio < tuning.volSurgeThreshold)
    disqualificationReason = `Guardrail: Volume surge ${s.volumeSurgeRatio}x below ${tuning.volSurgeThreshold}x confirmation threshold`;
  else if (!isBullBreak && !isBearBreak)
    disqualificationReason = "Price within 15-bar range boundaries; no breakout present";

  return {
    id: `setup-${tuning.idSuffix}-${symbol}`,
    name: tuning.name,
    family: "breakout_confirmation",
    direction,
    symbol,
    timeframe,
    entryPrice,
    stopLoss,
    takeProfit,
    riskRewardRatio: Number((targetDistance / stopDistance).toFixed(1)),
    baseProbability: tuning.baseProbability,
    qualifies,
    disqualificationReason,
    features: baseFeatures(s, s.ema9 > s.ema21),
  };
}

// ---------------------------------------------------------------------------
// Setup C family: Range Mean Reversion
// ---------------------------------------------------------------------------

export interface MeanReversionTuning {
  idSuffix: string;
  name: string;
  rsiOversold: number;
  rsiOverbought: number;
  maxAdxForRange: number;
  stopAtrMult: number;
  stopPriceFloorPct: number;
  baseProbability: number;
}

export const DEFAULT_MEANREV_TUNING = (promotedModel?: PromotedLabModel | null): MeanReversionTuning => {
  const params = promotedModel?.optimizedParameters;
  return {
    idSuffix: "meanrev",
    name: "Range Mean Reversion",
    rsiOversold: params ? (100 - params.rsiThreshold) : 32,
    rsiOverbought: params ? params.rsiThreshold : 68,
    maxAdxForRange: 26,
    stopAtrMult: 1.0,
    stopPriceFloorPct: 0.0035,
    baseProbability: 0.61,
  };
};

export function buildMeanReversionSetup(ctx: CandidateEvaluationContext, tuning: MeanReversionTuning): StrategySetup | null {
  const { symbol, timeframe, bars, regime, eventWindowActive } = ctx;
  const s = deriveSnapshot(bars);
  if (!s) return null;

  const isRsiOverbought = s.rsi >= tuning.rsiOverbought;
  const isRsiOversold = s.rsi <= tuning.rsiOversold;
  const isRangeRegime = regime === "ranging_tight" || regime === "ranging_wide";
  const direction: TradeDirection = isRsiOverbought ? "SHORT" : "LONG";
  const qualifies = isRangeRegime && (isRsiOverbought || isRsiOversold) && s.adx < tuning.maxAdxForRange && !eventWindowActive;

  const stopDistance = Math.max(s.atr * tuning.stopAtrMult, s.price * tuning.stopPriceFloorPct);
  const targetDistance = Math.abs(s.price - s.vwap);
  const entryPrice = s.price;
  const stopLoss = Number((direction === "LONG" ? s.price - stopDistance : s.price + stopDistance).toFixed(2));
  const takeProfit = Number((direction === "LONG" ? s.price + targetDistance : s.price - targetDistance).toFixed(2));

  let disqualificationReason: string | undefined;
  if (!isRangeRegime)
    disqualificationReason = "Guardrail: Mean reversion forbidden during trending or high-volatility regimes";
  else if (s.adx >= tuning.maxAdxForRange)
    disqualificationReason = `ADX >= ${tuning.maxAdxForRange} indicates developing directional momentum`;
  else if (!isRsiOverbought && !isRsiOversold)
    disqualificationReason = `RSI (${s.rsi}) in neutral zone (${tuning.rsiOversold}-${tuning.rsiOverbought}); deviation too small`;

  return {
    id: `setup-${tuning.idSuffix}-${symbol}`,
    name: tuning.name,
    family: "mean_reversion",
    direction,
    symbol,
    timeframe,
    entryPrice,
    stopLoss,
    takeProfit,
    riskRewardRatio: targetDistance > 0 ? Number((targetDistance / stopDistance).toFixed(1)) : 1.8,
    baseProbability: tuning.baseProbability,
    qualifies,
    disqualificationReason,
    features: baseFeatures(s, false),
  };
}

// ---------------------------------------------------------------------------
// Setup D family: Volatility Risk Filter (suppressor — fires as a desk-level
// veto, never as a directional trade). "qualifies: true" here means "danger,
// stand down" rather than "take this trade".
// ---------------------------------------------------------------------------

export function buildVolatilitySuppressor(ctx: CandidateEvaluationContext): StrategySetup | null {
  const { symbol, timeframe, bars, regime } = ctx;
  const s = deriveSnapshot(bars);
  if (!s) return null;

  const atrPercent = (s.atr / s.price) * 100;
  const dangerous = regime === "high_volatility_choppy" || atrPercent > 1.8;

  return {
    id: `setup-volguard-${symbol}`,
    name: "Volatility Risk Officer",
    family: "volatility_filter",
    direction: "LONG", // unused for a suppressor persona — no directional trade is ever placed off this setup
    symbol,
    timeframe,
    entryPrice: s.price,
    stopLoss: s.price,
    takeProfit: s.price,
    riskRewardRatio: 0,
    baseProbability: 0,
    qualifies: dangerous,
    disqualificationReason: dangerous ? undefined : "Volatility within tolerable bounds",
    features: baseFeatures(s, false),
  };
}

// ---------------------------------------------------------------------------
// Setup E family: Event/News Risk Filter (suppressor — vetoes trading through
// a binary-event blackout window).
// ---------------------------------------------------------------------------

export function buildEventNewsSuppressor(ctx: CandidateEvaluationContext): StrategySetup | null {
  const { symbol, timeframe, bars, eventWindowActive } = ctx;
  const s = deriveSnapshot(bars);
  if (!s) return null;

  return {
    id: `setup-eventguard-${symbol}`,
    name: "Event Risk Officer",
    family: "event_news_filter",
    direction: "LONG", // unused — suppressor persona only
    symbol,
    timeframe,
    entryPrice: s.price,
    stopLoss: s.price,
    takeProfit: s.price,
    riskRewardRatio: 0,
    baseProbability: 0,
    qualifies: eventWindowActive,
    disqualificationReason: eventWindowActive ? undefined : "No active event blackout",
    features: baseFeatures(s, false),
  };
}

// ---------------------------------------------------------------------------
// Legacy entry point — preserved for backward compatibility. Returns exactly
// the same three setups this file always produced (default tuning). The full
// panel of differentiated personas lives in personaEngine.ts.
// ---------------------------------------------------------------------------

export function evaluatePredefinedSetups(ctx: CandidateEvaluationContext): StrategySetup[] {
  if (ctx.bars.length < 5) return [];
  const setups: StrategySetup[] = [];
  const trend = buildTrendSetup(ctx, DEFAULT_TREND_TUNING);
  const breakout = buildBreakoutSetup(ctx, DEFAULT_BREAKOUT_TUNING(ctx.promotedModel));
  const meanrev = buildMeanReversionSetup(ctx, DEFAULT_MEANREV_TUNING(ctx.promotedModel));
  if (trend) setups.push(trend);
  if (breakout) setups.push(breakout);
  if (meanrev) setups.push(meanrev);
  return setups;
}
