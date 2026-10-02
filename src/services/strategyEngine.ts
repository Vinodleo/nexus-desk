import { MarketBar, StrategySetup, RegimeType, StrategyFamily, TradeDirection, PromotedLabModel } from "../types";
import { coinTargetDistance, planAtr, stopFloorPct } from "../shared/coinHolds";
import { barTime, recentSessions, sessionClock } from "../shared/sessionBars";

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
  /**
   * Only long trades can be placed (CoinDCX's INR markets are spot: selling
   * a coin you don't hold isn't possible). Short setups sit out the vote.
   */
  longOnly?: boolean;
  /**
   * Candles longer than 5 minutes (the history replay's slower trades): how
   * much more they move (volatilityScale), for limits tuned on 5-minute ones.
   */
  volatilityScale?: number;
}

/**
 * Rounds a stop or target to a sensible number of decimals for the coin's
 * price: 2 for ₹100 and up, more for cheaper coins, so a ₹0.0012 coin's stop
 * doesn't round to zero.
 */
export function roundPrice(v: number, reference: number): number {
  const abs = Math.abs(reference);
  const decimals = abs >= 100 ? 2 : abs >= 1 ? 4 : Math.min(12, 4 + Math.ceil(-Math.log10(abs || 1e-12)));
  return Number(v.toFixed(decimals));
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
  /** The ATR stops and targets are sized on: hourly for coins (shared/coinHolds). */
  planAtr: number;
  bbUpper: number;
  bbLower: number;
  volumeSurgeRatio: number;
  vwapDistPercent: number;
  recentHigh: number;
  recentLow: number;
}

function deriveSnapshot(bars: MarketBar[], symbol?: string): IndicatorSnapshot | null {
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
  const plan = planAtr(symbol, current);
  return { price, ema9, ema21, ema50, ema200, vwap, rsi, adx, atr, planAtr: plan, bbUpper, bbLower, volumeSurgeRatio, vwapDistPercent, recentHigh, recentLow };
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
  const stopLoss = roundPrice(direction === "LONG" ? s.price - stopDistance : s.price + stopDistance, s.price);
  const takeProfit = roundPrice(direction === "LONG" ? s.price + targetDistance : s.price - targetDistance, s.price);

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
    // Multi-day holds on the 50/200 EMA structure: its own swing panel,
    // manual approval only.
    horizon: "swing",
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
  const s = deriveSnapshot(bars, symbol);
  if (!s) return null;

  const isBullTrend = s.ema9 > s.ema21 && s.ema21 > s.ema50 && s.price > s.vwap && s.adx >= tuning.minAdx;
  const isBearTrend = s.ema9 < s.ema21 && s.ema21 < s.ema50 && s.price < s.vwap && s.adx >= tuning.minAdx;
  const direction: TradeDirection = isBullTrend ? "LONG" : "SHORT";
  const qualifies = (isBullTrend || isBearTrend) && regime !== "high_volatility_choppy" && !eventWindowActive;

  const stopDistance = Math.max(s.planAtr * tuning.stopAtrMult, s.price * stopFloorPct(symbol, tuning.stopPriceFloorPct));
  const targetDistance = coinTargetDistance(symbol, stopDistance * tuning.targetMult, stopDistance);
  const entryPrice = s.price;
  const stopLoss = roundPrice(direction === "LONG" ? s.price - stopDistance : s.price + stopDistance, s.price);
  const takeProfit = roundPrice(direction === "LONG" ? s.price + targetDistance : s.price - targetDistance, s.price);

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
    riskRewardRatio: Number((targetDistance / stopDistance).toFixed(1)),
    baseProbability: tuning.baseProbability,
    qualifies,
    disqualificationReason,
    planAtr: s.planAtr,
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
  /**
   * Optional overextension filter, as the Lab's backtest applies it: longs
   * only while RSI is below this, shorts only while it's above 100 minus it.
   */
  rsiCeiling?: number;
}

export function buildBreakoutSetup(ctx: CandidateEvaluationContext, tuning: BreakoutTuning): StrategySetup | null {
  const { symbol, timeframe, bars, eventWindowActive } = ctx;
  const s = deriveSnapshot(bars, symbol);
  if (!s) return null;

  const isBullBreak = s.price > s.recentHigh && s.volumeSurgeRatio >= tuning.volSurgeThreshold;
  const isBearBreak = s.price < s.recentLow && s.volumeSurgeRatio >= tuning.volSurgeThreshold;
  const direction: TradeDirection = isBullBreak ? "LONG" : isBearBreak ? "SHORT" : (s.price >= (s.recentHigh + s.recentLow) / 2 ? "LONG" : "SHORT");
  const overextended =
    tuning.rsiCeiling !== undefined &&
    ((isBullBreak && s.rsi >= tuning.rsiCeiling) || (isBearBreak && s.rsi <= 100 - tuning.rsiCeiling));
  const qualifies = (isBullBreak || isBearBreak) && !overextended && !eventWindowActive;

  const stopDistance = Math.max(s.planAtr * tuning.stopAtrMult, s.price * stopFloorPct(symbol, tuning.stopPriceFloorPct));
  const targetDistance = coinTargetDistance(symbol, Math.max(s.planAtr * tuning.targetAtrMult, stopDistance * tuning.targetStopMultFloor), stopDistance);
  const entryPrice = s.price;
  const stopLoss = roundPrice(direction === "LONG" ? s.price - stopDistance : s.price + stopDistance, s.price);
  const takeProfit = roundPrice(direction === "LONG" ? s.price + targetDistance : s.price - targetDistance, s.price);

  let disqualificationReason: string | undefined;
  if (eventWindowActive)
    disqualificationReason = "Event filter active";
  else if (s.volumeSurgeRatio < tuning.volSurgeThreshold)
    disqualificationReason = `Guardrail: Volume surge ${s.volumeSurgeRatio}x below ${tuning.volSurgeThreshold}x confirmation threshold`;
  else if (!isBullBreak && !isBearBreak)
    disqualificationReason = "Price within 15-bar range boundaries; no breakout present";
  else if (overextended)
    disqualificationReason = `RSI ${s.rsi.toFixed(0)} too stretched for a breakout entry (limit ${tuning.rsiCeiling})`;

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
    planAtr: s.planAtr,
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

export function buildMeanReversionSetup(ctx: CandidateEvaluationContext, tuning: MeanReversionTuning): StrategySetup | null {
  const { symbol, timeframe, bars, regime, eventWindowActive } = ctx;
  const s = deriveSnapshot(bars, symbol);
  if (!s) return null;

  const isRsiOverbought = s.rsi >= tuning.rsiOverbought;
  const isRsiOversold = s.rsi <= tuning.rsiOversold;
  const isRangeRegime = regime === "ranging_tight" || regime === "ranging_wide";
  const direction: TradeDirection = isRsiOverbought ? "SHORT" : "LONG";
  const qualifies = isRangeRegime && (isRsiOverbought || isRsiOversold) && s.adx < tuning.maxAdxForRange && !eventWindowActive;

  const stopDistance = Math.max(s.planAtr * tuning.stopAtrMult, s.price * stopFloorPct(symbol, tuning.stopPriceFloorPct));
  // Back to VWAP; a coin trade, held for hours, aims at least 2x its stop,
  // or the spread eats a target that close.
  const targetDistance = coinTargetDistance(symbol, Math.abs(s.price - s.vwap), stopDistance);
  const entryPrice = s.price;
  const stopLoss = roundPrice(direction === "LONG" ? s.price - stopDistance : s.price + stopDistance, s.price);
  const takeProfit = roundPrice(direction === "LONG" ? s.price + targetDistance : s.price - targetDistance, s.price);

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
    planAtr: s.planAtr,
    features: baseFeatures(s, false),
  };
}

// ---------------------------------------------------------------------------
// Setup F: Opening Range Breakout on stocks in play (US and Indian stocks)
// ---------------------------------------------------------------------------
// The opening range is the session's first 5-minute candle. A stock is "in
// play" when that candle traded at least `minRelativeVolume` times its
// usual opening volume (the same candle's average over the previous few
// sessions held): research on US stocks (Zarattini, Barbon & Aziz, 2024)
// found opening-range breakouts paid on such stocks and mostly failed on
// quiet ones. The first candle's colour picks the side: after a rising one
// a close above its high is bought, after a falling one a close below its
// low is sold short (not in the US, where the desk only buys). Only the
// first such close counts, and only in the first `entryWindowBars` candles.
// The stop sits at the far side of the range (never nearer than the
// market's minimum), the target at `targetStopMult` times the stop.

export interface OpeningRangeTuning {
  idSuffix: string;
  name: string;
  minRelativeVolume: number;
  /** Earlier sessions whose opening candle is held, needed to know the usual volume. */
  minPriorSessions: number;
  /** Candles after the opening one in which the breakout may come. */
  entryWindowBars: number;
  stopPriceFloorPct: number;
  targetStopMult: number;
  baseProbability: number;
}

export function buildOpeningRangeSetup(ctx: CandidateEvaluationContext, tuning: OpeningRangeTuning): StrategySetup | null {
  const { symbol, timeframe, bars, eventWindowActive } = ctx;
  const clock = sessionClock(symbol);
  const latest = bars[bars.length - 1];
  if (!clock || !latest || latest.timestampMs === undefined) return null;
  // Cheap check first (the replay asks at every candle): only in the window after the opening candle.
  const sinceOpen = barTime(latest, clock).minutes - clock.open;
  if (sinceOpen < 5 || sinceOpen > tuning.entryWindowBars * 5) return null;
  const sessions = recentSessions(clock, bars, tuning.minPriorSessions + 3);
  const today = sessions[sessions.length - 1];
  // The day's real opening candle must be held, and enough earlier ones to know its usual volume.
  if (!today || today.minutes[0] !== clock.open) return null;
  const opening = today.bars[0];
  const earlier = sessions
    .slice(0, -1)
    .filter((d) => d.minutes[0] === clock.open && d.bars[0].volume > 0)
    .map((d) => d.bars[0].volume);
  if (earlier.length < tuning.minPriorSessions) return null;
  const s = deriveSnapshot(bars, symbol);
  if (!s) return null;

  const relativeVolume = opening.volume / (earlier.reduce((a, v) => a + v, 0) / earlier.length);
  const rising = opening.close > opening.open;
  const falling = opening.close < opening.open;
  const direction: TradeDirection = falling ? "SHORT" : "LONG";
  const beyond = (b: MarketBar) => (direction === "LONG" ? b.close > opening.high : b.close < opening.low);
  const after = today.bars.slice(1);
  const firstBreak = after.length > 0 && beyond(after[after.length - 1]) && after.slice(0, -1).every((b) => !beyond(b));
  const inPlay = relativeVolume >= tuning.minRelativeVolume;
  const qualifies = (rising || falling) && inPlay && firstBreak && !eventWindowActive;

  const toFarSide = direction === "LONG" ? s.price - opening.low : opening.high - s.price;
  const stopDistance = Math.max(toFarSide, s.price * stopFloorPct(symbol, tuning.stopPriceFloorPct));
  const targetDistance = coinTargetDistance(symbol, stopDistance * tuning.targetStopMult, stopDistance);
  const stopLoss = roundPrice(direction === "LONG" ? s.price - stopDistance : s.price + stopDistance, s.price);
  const takeProfit = roundPrice(direction === "LONG" ? s.price + targetDistance : s.price - targetDistance, s.price);

  let disqualificationReason: string | undefined;
  if (eventWindowActive) disqualificationReason = "Event filter active";
  else if (!rising && !falling) disqualificationReason = "Opening candle closed where it opened: no side to trade";
  else if (!inPlay)
    disqualificationReason = `Opening volume ${relativeVolume.toFixed(1)}x usual, below ${tuning.minRelativeVolume}x: not in play`;
  else if (!firstBreak) disqualificationReason = "No first close beyond the opening range";

  return {
    id: `setup-${tuning.idSuffix}-${symbol}`,
    name: tuning.name,
    family: "breakout_confirmation",
    direction,
    symbol,
    timeframe,
    entryPrice: s.price,
    stopLoss,
    takeProfit,
    riskRewardRatio: Number((targetDistance / stopDistance).toFixed(1)),
    baseProbability: tuning.baseProbability,
    qualifies,
    disqualificationReason,
    planAtr: s.planAtr,
    features: { ...baseFeatures(s, s.ema9 > s.ema21), volumeSurgeRatio: Number(relativeVolume.toFixed(2)) },
  };
}

// ---------------------------------------------------------------------------
// Setup G: Late-day momentum on US index funds
// ---------------------------------------------------------------------------
// Research on the S&P 500 (Gao, Han, Li & Zhou, 2018) found the first half
// hour's move, from the previous close to 10:00 New York time, tends to
// carry on into the last half hour. So once a day, at the candle closing at
// `entryCloseMinutes` (3:25, the last before new US trades stop), a fund
// whose first half hour rose is bought (fell: a short, which the US desk
// sits out). It's closed at 3:50 with every US trade.

export interface LateMomentumTuning {
  idSuffix: string;
  name: string;
  /** The funds it trades. */
  symbols: string[];
  /** New York minutes: the first half hour ends at this candle close (10:00). */
  measureCloseMinutes: number;
  /** New York minutes: the trade is taken at this candle close (3:25). */
  entryCloseMinutes: number;
  stopAtrMult: number;
  stopPriceFloorPct: number;
  targetStopMult: number;
  baseProbability: number;
}

export function buildLateMomentumSetup(ctx: CandidateEvaluationContext, tuning: LateMomentumTuning): StrategySetup | null {
  const { symbol, timeframe, bars, eventWindowActive } = ctx;
  if (!tuning.symbols.includes(symbol)) return null;
  const clock = sessionClock(symbol);
  const latest = bars[bars.length - 1];
  if (!clock || !latest || latest.timestampMs === undefined) return null;
  // Once a day: only at the entry candle.
  if (barTime(latest, clock).minutes + 5 !== tuning.entryCloseMinutes) return null;
  const [yesterday, today] = recentSessions(clock, bars, 2);
  if (!yesterday || !today) return null;
  // Yesterday must have run to its close (not a half day or a gap in the candles), and today's 10:00 candle be held.
  if (yesterday.minutes[yesterday.minutes.length - 1] + 5 !== clock.close) return null;
  const at10 = today.minutes.indexOf(tuning.measureCloseMinutes - 5);
  if (at10 < 0) return null;
  const s = deriveSnapshot(bars, symbol);
  if (!s) return null;

  const firstHalfHour = today.bars[at10].close / yesterday.bars[yesterday.bars.length - 1].close - 1;
  const direction: TradeDirection = firstHalfHour < 0 ? "SHORT" : "LONG";
  const qualifies = firstHalfHour !== 0 && !eventWindowActive;

  const stopDistance = Math.max(s.planAtr * tuning.stopAtrMult, s.price * tuning.stopPriceFloorPct);
  const targetDistance = stopDistance * tuning.targetStopMult;
  const stopLoss = roundPrice(direction === "LONG" ? s.price - stopDistance : s.price + stopDistance, s.price);
  const takeProfit = roundPrice(direction === "LONG" ? s.price + targetDistance : s.price - targetDistance, s.price);

  return {
    id: `setup-${tuning.idSuffix}-${symbol}`,
    name: tuning.name,
    family: "trend_following",
    direction,
    symbol,
    timeframe,
    entryPrice: s.price,
    stopLoss,
    takeProfit,
    riskRewardRatio: tuning.targetStopMult,
    baseProbability: tuning.baseProbability,
    qualifies,
    disqualificationReason: eventWindowActive
      ? "Event filter active"
      : firstHalfHour === 0
      ? "Flat first half hour: no direction"
      : undefined,
    planAtr: s.planAtr,
    features: baseFeatures(s, s.ema9 > s.ema21),
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

  const atrPercent = ((s.atr / s.price) * 100) / (ctx.volatilityScale ?? 1);
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
