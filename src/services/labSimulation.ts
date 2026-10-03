import type { MarketBar, RegimeType, StrategySetup } from "../types";
import { classifyRegime, decorateBarsWithIndicators } from "./marketDataService";
import { buildBreakoutSetup } from "./strategyEngine";
import { runPersonaPanel } from "./personaEngine";
import { computeMetaLabelScore } from "./metaLabeling";
import { resolveShadow, shadowFromSetup } from "./shadowTracker";
import { metaFeatures } from "./metaFeatures";
import { SIGNAL_INTERVAL_MS } from "./liveMarketStreamService";
import { isNseSymbol, nseTakesEntries } from "../shared/nse";
import { isUsSymbol, usTakesEntries } from "../shared/usMarket";
import { holdMinutesFor } from "../shared/coinHolds";
import { sessionClock } from "../shared/sessionBars";

// The Lab's replay of live trading on historical 5-minute candles: the same
// indicators, the same setup builders (the live trader panel, and the
// breakout builder the Lab-tuned trader uses), the same model inputs, and
// trades resolved the way shadow tracking resolves live setups (target, stop
// or the time limit, whichever comes first: 4 hours for a coin, 30 minutes
// for a stock).

/** Candles are 5 minutes, like the live scanner's. */
export const LAB_INTERVAL = "5m";
export const LAB_INTERVAL_MS = SIGNAL_INTERVAL_MS;
/** Fees both ways (0.10%) plus an allowance for spread and slippage, per trade. */
export const LAB_COST_PCT = 0.15;
/** Candles before the first signal, so ATR, RSI and ADX have settled. */
const WARMUP_BARS = 30;
/** Candles each signal's builders see (they look back 15). */
const WINDOW_BARS = 21;
/** Candles handed to resolution: the setup's time limit in candles, and a little extra for its close. */
const resolveBarsFor = (setup: StrategySetup) => Math.ceil((holdMinutesFor(setup) * 60 * 1000) / LAB_INTERVAL_MS) + 2;
/** After a trader's signal, their next few candles on the same coin aren't counted again. */
export const REPLAY_COOLDOWN_BARS = 3;

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
 * For slower candles, `periodMs` is the higher timeframe's length instead (a
 * day above hourly candles, a week above daily ones).
 */
export function hourlyRegimeLookup(bars: MarketBar[], periodMs: number = 60 * 60 * 1000, scale: number = 1): (ms: number) => RegimeType | "neutral" {
  const hours: MarketBar[] = [];
  for (const b of bars) {
    const t = b.timestampMs ?? 0;
    const start = Math.floor(t / periodMs) * periodMs;
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
      if (starts[mid] + periodMs <= ms) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return k >= 30 ? classifyRegime(decorated[k], scale) : "neutral";
  };
}

/** Follows a setup from bar `i`'s close, like shadow tracking; null if the data ends first. */
function resolveFrom(setup: StrategySetup, bars: MarketBar[], i: number) {
  const signalTime = (bars[i].timestampMs as number) + LAB_INTERVAL_MS;
  const need = resolveBarsFor(setup);
  const after = bars.slice(i + 1, i + 1 + need);
  const s = resolveShadow(shadowFromSetup(setup, "proposed", signalTime), after, Number.MAX_SAFE_INTEGER);
  if (s.status === "open" || s.exitPrice === undefined) return null;
  // Too few candles to reach the time limit: not a real result.
  if (s.status === "expired" && after.length < need) return null;
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
 * trades whose score clears `params.minConfidence`.
 */
export function simulateTunedBreakout(symbol: string, bars: MarketBar[], params: LabParams): LabTrade[] {
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
    // A simple score from trend alignment (% change over 20 candles) and volume.
    const slope = features[5];
    let confidence = 0.5;
    if (slope > 0.2) confidence += 0.12;
    if (features[1] * 5 > 1.5) confidence += 0.08;
    if (regime === "high_volatility_choppy") confidence -= 0.14;
    candidates.push({ i, setup, regime, confidence, features });
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


/**
 * How much more a candle of `intervalMs` moves than a 5-minute one:
 * volatility grows with the square root of time, so limits tuned on
 * 5-minute candles are scaled by it for slower ones. A stock's day is its
 * session (75 or 78 five-minute candles), its week five of them.
 */
export function volatilityScale(symbol: string, intervalMs: number): number {
  const DAY = 24 * 60 * 60 * 1000;
  const clock = sessionClock(symbol);
  if (clock && intervalMs >= DAY) {
    const sessions = intervalMs >= 7 * DAY ? 5 : intervalMs / DAY;
    return Math.sqrt(((clock.close - clock.open) / 5) * sessions);
  }
  return Math.sqrt(intervalMs / LAB_INTERVAL_MS);
}

/**
 * Whether the live scanner takes a new trade in this market at `ms`: coins
 * any time, stocks only in their entry hours (a US stock from the open to
 * 3:30 New York time, an Indian one from the open to 3:00 IST).
 */
export function takesEntriesAt(symbol: string, ms: number): boolean {
  if (!Number.isFinite(ms)) return true;
  if (isUsSymbol(symbol)) return usTakesEntries(ms);
  if (isNseSymbol(symbol)) return nseTakesEntries(ms);
  return true;
}

/**
 * Every intraday setup the live trader panel (with the 1-hour trend check)
 * would have put forward on history, at the candle it came from: long-only
 * for coins (CoinDCX spot can't short), both ways for stocks. After a
 * trader's signal, their next few candles on the coin aren't counted again
 * (each trader's own: another trader's signal doesn't hide theirs). A stock
 * setup counts only in the hours the live scanner takes trades: one near
 * the close would otherwise be judged across the night's gap, which a live
 * trade (closed before the close) never is.
 *
 * The traders see every candle up to the one they're judging, as they do
 * live: most read only the last 15, but the opening range and late-day
 * momentum traders read the session itself (its opening candle, earlier
 * days' openings, yesterday's close). On long histories, `view` caps that at
 * the candles the server holds live, and `from`/`to` judge only part of
 * `bars` (the rest is warm-up before, and room for exits after).
 */
export function panelSetupsOnHistory(
  symbol: string,
  bars: MarketBar[],
  longOnly: boolean = !isNseSymbol(symbol),
  range: {
    from?: number;
    to?: number;
    view?: number;
    /** Slower candles: their length, and the higher timeframe's (the trend check); 5 minutes and an hour by default. */
    intervalMs?: number;
    higherMs?: number;
    /** Trades taken at any candle's close, not only in stocks' entry hours (daily candles close after them). */
    anyTime?: boolean;
    /** The last candle too (live: the one just closed), which a replay leaves for the trade to play out on. */
    throughLast?: boolean;
  } = {}
): { i: number; regime: RegimeType; macro: RegimeType | "neutral"; setups: StrategySetup[] }[] {
  const interval = range.intervalMs ?? LAB_INTERVAL_MS;
  // Slower candles move more: the volatility limits (tuned on 5-minute ones) scale with them.
  const scale = range.intervalMs ? volatilityScale(symbol, interval) : 1;
  const macroAt = hourlyRegimeLookup(bars, range.higherMs, range.higherMs ? volatilityScale(symbol, range.higherMs) : 1);
  const out: { i: number; regime: RegimeType; macro: RegimeType | "neutral"; setups: StrategySetup[] }[] = [];
  /** The last candle each trader (by setup name) is still spaced out until. */
  const spacedUntil = new Map<string, number>();
  const view = range.view ?? Infinity;
  const end = range.throughLast ? bars.length : bars.length - 1;
  for (let i = Math.max(WARMUP_BARS, range.from ?? 0); i < Math.min(end, range.to ?? Infinity); i++) {
    if (!range.anyTime && !takesEntriesAt(symbol, (bars[i].timestampMs as number) + interval)) continue;
    const regime = classifyRegime(bars[i], scale);
    const macro = macroAt((bars[i].timestampMs as number) + interval);
    const panel = runPersonaPanel(
      {
        symbol,
        timeframe: range.intervalMs ? `${range.intervalMs / 60_000}m` : LAB_INTERVAL,
        bars: bars.slice(Math.max(0, i + 1 - view), i + 1),
        regime,
        eventWindowActive: false,
        longOnly,
        macroRegime: macro,
        ...(scale !== 1 ? { volatilityScale: scale } : {}),
      },
      (setup) => computeMetaLabelScore({ setup, regime, empiricalWinRate: 0.5, sampleCount: 0, similarityScore: 1 }),
      "intraday"
    );
    const setups = panel.candidates.filter((s) => (spacedUntil.get(s.name) ?? -1) < i);
    if (setups.length === 0) continue;
    for (const s of setups) spacedUntil.set(s.name, i + REPLAY_COOLDOWN_BARS);
    out.push({ i, regime, macro, setups });
  }
  return out;
}
