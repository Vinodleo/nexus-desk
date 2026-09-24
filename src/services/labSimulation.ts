import type { MarketBar, RegimeType, StrategySetup } from "../types";
import type * as tf from "@tensorflow/tfjs";
import { classifyRegime, decorateBarsWithIndicators } from "./marketDataService";
import { buildBreakoutSetup } from "./strategyEngine";
import { runPersonaPanel } from "./personaEngine";
import { computeMetaLabelScore } from "./metaLabeling";
import { resolveShadow, shadowFromSetup } from "./shadowTracker";
import { metaFeatures } from "./metaFeatures";
import { predictConfidenceBatch } from "./mlService";
import { SIGNAL_INTERVAL_MS } from "./liveMarketStreamService";

// The Lab's replay of live trading on historical 5-minute candles: the same
// indicators, the same setup builders (the live trader panel, and the
// breakout builder the Lab-tuned trader uses), the same model inputs, and
// trades resolved the way shadow tracking resolves live setups (target, stop
// or 30 minutes, whichever comes first).

/** Candles are 5 minutes, like the live scanner's. */
export const LAB_INTERVAL = "5m";
export const LAB_INTERVAL_MS = SIGNAL_INTERVAL_MS;
/** Fees both ways (0.10%) plus an allowance for spread and slippage, per trade. */
export const LAB_COST_PCT = 0.15;
/** Candles before the first signal, so ATR, RSI and ADX have settled. */
const WARMUP_BARS = 30;
/** Candles each signal's builders see (they look back 15). */
const WINDOW_BARS = 21;
/** Candles handed to resolution: the 30-minute limit is 6; a little extra for its close. */
const RESOLVE_BARS = 8;
/** After a signal, the next few candles on the same coin aren't counted again. */
const REPLAY_COOLDOWN_BARS = 3;

export interface LabParams {
  slMultiplier: number;
  tpMultiplier: number;
  volSurgeThreshold: number;
  rsiThreshold: number;
  minConfidence: number;
}

export interface LabTrade {
  symbol: string;
  direction: "LONG" | "SHORT";
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  /** After LAB_COST_PCT. */
  pnlPercent: number;
  isWin: boolean;
  exitReason: "TAKE_PROFIT" | "STOP_LOSS" | "TIMEOUT";
  metaConfidence: number;
  regime: RegimeType;
  features: number[];
}

/** Historical candles (oldest first) to the scanner's bars, with its indicators. */
export function toLabBars(
  candles: { timestamp: number; open: number; high: number; low: number; close: number; volume: number; isSynthetic?: boolean }[]
): MarketBar[] {
  return decorateBarsWithIndicators(
    candles.map((c) => ({
      time: new Date(c.timestamp).toISOString(),
      timestampMs: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      ...(c.isSynthetic ? { isSynthetic: true } : {}),
    }))
  );
}

/** Typical spacing between candles, in ms (the median gap). */
export function candleSpacingMs(timestamps: number[]): number {
  const gaps = timestamps
    .slice(1)
    .map((t, i) => t - timestamps[i])
    .filter((g) => g > 0)
    .sort((a, b) => a - b);
  return gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : 0;
}

/**
 * The 1-hour regime known at each moment, from hourly candles built out of
 * the 5-minute ones: what the live scanner's higher-timeframe check uses.
 */
export function hourlyRegimeLookup(bars: MarketBar[]): (ms: number) => RegimeType | "neutral" {
  const HOUR = 60 * 60 * 1000;
  const hours: MarketBar[] = [];
  for (const b of bars) {
    const t = b.timestampMs ?? 0;
    const start = Math.floor(t / HOUR) * HOUR;
    const last = hours[hours.length - 1];
    if (last && last.timestampMs === start) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume;
    } else {
      hours.push({ time: new Date(start).toISOString(), timestampMs: start, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
    }
  }
  const decorated = decorateBarsWithIndicators(hours);
  const starts = decorated.map((h) => h.timestampMs as number);
  return (ms: number) => {
    // The last hour that had closed by `ms`, with enough history behind it.
    let k = -1;
    for (let lo = 0, hi = starts.length - 1; lo <= hi; ) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] + HOUR <= ms) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return k >= 30 ? classifyRegime(decorated[k]) : "neutral";
  };
}

/** Follows a setup from bar `i`'s close, like shadow tracking; null if the data ends first. */
function resolveFrom(setup: StrategySetup, bars: MarketBar[], i: number) {
  const signalTime = (bars[i].timestampMs as number) + LAB_INTERVAL_MS;
  const after = bars.slice(i + 1, i + 1 + RESOLVE_BARS);
  const s = resolveShadow(shadowFromSetup(setup, "proposed", signalTime), after, Number.MAX_SAFE_INTEGER);
  if (s.status === "open" || s.exitPrice === undefined) return null;
  // Too few candles to reach the time limit: not a real result.
  if (s.status === "expired" && after.length < RESOLVE_BARS) return null;
  return s;
}

function toTrade(symbol: string, setup: StrategySetup, bars: MarketBar[], i: number, regime: RegimeType, confidence: number, features: number[]): LabTrade | null {
  const s = resolveFrom(setup, bars, i);
  if (!s) return null;
  const raw = setup.direction === "LONG" ? (s.exitPrice! - s.entryPrice) / s.entryPrice : (s.entryPrice - s.exitPrice!) / s.entryPrice;
  const pnlPercent = raw * 100 - LAB_COST_PCT;
  return {
    symbol,
    direction: setup.direction,
    entryTime: bars[i].time.replace("T", " ").slice(0, 16),
    exitTime: new Date(s.resolvedAt ?? s.expiresAt).toISOString().replace("T", " ").slice(0, 16),
    entryPrice: s.entryPrice,
    exitPrice: s.exitPrice!,
    pnlPercent: Number(pnlPercent.toFixed(3)),
    isWin: pnlPercent > 0,
    exitReason: s.status === "target" ? "TAKE_PROFIT" : s.status === "stop" ? "STOP_LOSS" : "TIMEOUT",
    metaConfidence: confidence,
    regime,
    features,
  };
}

/**
 * The Lab-tuned breakout trader on history: the live breakout builder with
 * these settings (as labTunedPersona applies them), taking non-overlapping
 * trades. With a model, its score must clear `params.minConfidence`.
 */
export function simulateTunedBreakout(symbol: string, bars: MarketBar[], params: LabParams, model?: tf.LayersModel): LabTrade[] {
  const candidates: { i: number; setup: StrategySetup; regime: RegimeType; confidence: number; features: number[] }[] = [];
  for (let i = WARMUP_BARS; i < bars.length - 1; i++) {
    const regime = classifyRegime(bars[i]);
    const setup = buildBreakoutSetup(
      { symbol, timeframe: LAB_INTERVAL, bars: bars.slice(i - WINDOW_BARS + 1, i + 1), regime, eventWindowActive: false },
      {
        idSuffix: "lab-sim",
        name: "Lab Tuned Breakout",
        volSurgeThreshold: params.volSurgeThreshold,
        stopAtrMult: params.slMultiplier,
        stopPriceFloorPct: 0.0025,
        targetAtrMult: params.tpMultiplier,
        targetStopMultFloor: 1.0,
        baseProbability: 0.5,
        rsiCeiling: params.rsiThreshold,
      }
    );
    // CoinDCX spot can't short, so neither does the Lab (its history is crypto).
    if (!setup?.qualifies || setup.direction === "SHORT") continue;
    const features = metaFeatures(bars, i);
    // Without a model: a simple score from trend alignment (% change over
    // 20 candles) and volume.
    const slope = features[5];
    let confidence = 0.5;
    if (slope > 0.2) confidence += 0.12;
    if (features[1] * 5 > 1.5) confidence += 0.08;
    if (regime === "high_volatility_choppy") confidence -= 0.14;
    candidates.push({ i, setup, regime, confidence, features });
  }
  if (model && candidates.length > 0) {
    const scores = predictConfidenceBatch(model, candidates.map((c) => c.features));
    candidates.forEach((c, k) => (c.confidence = scores[k]));
  }

  const trades: LabTrade[] = [];
  let busyUntil = -1;
  for (const c of candidates) {
    if (c.i <= busyUntil) continue;
    if (c.confidence < params.minConfidence) continue;
    const trade = toTrade(symbol, c.setup, bars, c.i, c.regime, c.confidence, c.features);
    if (!trade) continue;
    trades.push(trade);
    busyUntil = c.i + 6;
  }
  return trades;
}

export interface PanelSample {
  features: number[];
  win: boolean;
  pnlPercent: number;
}

/**
 * Every intraday setup the live trader panel (long-only, with the 1-hour
 * trend check) would have put forward on history, at the candle it came
 * from. After a signal, the next few candles on the coin aren't counted again.
 */
export function panelSetupsOnHistory(symbol: string, bars: MarketBar[]): { i: number; regime: RegimeType; setups: StrategySetup[] }[] {
  const macroAt = hourlyRegimeLookup(bars);
  const out: { i: number; regime: RegimeType; setups: StrategySetup[] }[] = [];
  for (let i = WARMUP_BARS; i < bars.length - 1; i++) {
    const regime = classifyRegime(bars[i]);
    const panel = runPersonaPanel(
      {
        symbol,
        timeframe: LAB_INTERVAL,
        bars: bars.slice(i - WINDOW_BARS + 1, i + 1),
        regime,
        eventWindowActive: false,
        longOnly: true,
        macroRegime: macroAt((bars[i].timestampMs as number) + LAB_INTERVAL_MS),
      },
      (setup) => computeMetaLabelScore({ setup, regime, empiricalWinRate: 0.5, sampleCount: 0, similarityScore: 1 }),
      "intraday"
    );
    if (panel.candidates.length === 0) continue;
    out.push({ i, regime, setups: panel.candidates });
    i += REPLAY_COOLDOWN_BARS;
  }
  return out;
}

/**
 * The live trader panel on history: every intraday setup it would have put
 * forward, with the model inputs at that candle and how it turned out. This
 * is what the confidence model scores live, so it's what it learns from.
 */
export function replayPanel(symbol: string, bars: MarketBar[]): PanelSample[] {
  const samples: PanelSample[] = [];
  for (const { i, regime, setups } of panelSetupsOnHistory(symbol, bars)) {
    // Every trader's setup is scored live, so each is a training sample.
    const features = metaFeatures(bars, i);
    for (const setup of setups) {
      const trade = toTrade(symbol, setup, bars, i, regime, 0.5, features);
      if (trade) samples.push({ features, win: trade.isWin, pnlPercent: trade.pnlPercent });
    }
  }
  return samples;
}
