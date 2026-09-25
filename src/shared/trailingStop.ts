import { isUsSymbol, US_BREAKEVEN_BUFFER } from "./usMarket";
import { isNseSymbol } from "./nse";
import { NSE_BREAKEVEN_BUFFER } from "./exitRules";

// Trailing stops, shared by the browser book (positionTick) and the server
// guardian (guardianLogic), so a position is trailed the same way whichever
// side sees a price first. (They used to be two copies that had drifted: the
// server never let a trend trade run past its first target, and started
// trailing later.)
//
// Two modes:
// - Scalp: once a trade has moved 0.6%, 1 ATR or 40% of the way to target,
//   the stop moves past break-even plus fees, then locks in 50% of the best
//   gain (from 1 ATR / half way) and 70% (from 1.8 ATR / three quarters).
// - Trend runner (trend, breakout and swing trades): once 0.8%, 1.2 ATR or
//   half way, the stop follows 1.5 ATR behind the best price, never below
//   break-even. Past the first target, the stop locks at that target and the
//   target extends 1.5x further, so a strong move keeps running.

export interface TrailState {
  /** NSE stocks cost more to trade, so their trailing stops sit further past entry. */
  symbol?: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  /** The target when the position opened; the runner's lock level. */
  initialTakeProfit?: number;
  highestPrice?: number;
  lowestPrice?: number;
  trailActive?: boolean;
  atrAtEntry?: number;
  trailMode?: "SCALP_TIGHT" | "TREND_RUNNER";
  family?: string;
  expectedHoldingTimeMinutes?: number;
  /** Which TRAIL_PROFILES entry this position trails by (default "tight"). */
  trailProfile?: string;
}

export type TrailExitReason = "TAKE_PROFIT" | "STOP_LOSS" | "TRAILING_STOP";

/**
 * How a trailing stop behaves. "tight" is the original setting; the others
 * start later and lock in less of the gain, so normal 5-minute wobbles are
 * less likely to stop a trade out with a small win. "fixed" never trails:
 * the baseline the Lab compares against. The Lab's exit comparison measures
 * them on history, and new positions carry the one in use (trailProfile).
 */
export interface TrailProfile {
  label: string;
  /** Scalp trades: start trailing at this % gain, ATR multiple or share of the way to target. */
  scalpStart: { pct: number; atr: number; progress: number };
  /** Scalp trades: lock in this share of the best gain once past these marks (checked strongest first). */
  scalpLocks: { atr: number; progress: number; share: number }[];
  /** Least a scalp stop sits past entry once trailing (fees and spread). */
  scalpFloor: number;
  runnerStart: { pct: number; atr: number; progress: number };
  /** Runner: the stop follows this many ATR behind the best price. */
  runnerTrailAtr: number;
  runnerFloor: number;
  /** Past the first target, the runner's target moves out by this multiple of the original distance. */
  runnerExtend: number;
  /** Never trail: the original stop and target only. */
  fixed?: boolean;
}

export type TrailProfileId = "tight" | "balanced" | "patient" | "fixed";

export const TRAIL_PROFILES: Record<TrailProfileId, TrailProfile> = {
  tight: {
    label: "Tight",
    scalpStart: { pct: 0.6, atr: 1.0, progress: 0.4 },
    scalpLocks: [
      { atr: 1.8, progress: 0.75, share: 0.7 },
      { atr: 1.0, progress: 0.5, share: 0.5 },
    ],
    scalpFloor: 0.0018,
    runnerStart: { pct: 0.8, atr: 1.2, progress: 0.5 },
    runnerTrailAtr: 1.5,
    runnerFloor: 0.002,
    runnerExtend: 1.5,
  },
  balanced: {
    label: "Balanced",
    scalpStart: { pct: 1.0, atr: 1.5, progress: 0.6 },
    scalpLocks: [
      { atr: 2.2, progress: 0.85, share: 0.6 },
      { atr: 1.5, progress: 0.6, share: 0.4 },
    ],
    scalpFloor: 0.0018,
    runnerStart: { pct: 1.2, atr: 1.8, progress: 0.6 },
    runnerTrailAtr: 2.0,
    runnerFloor: 0.002,
    runnerExtend: 1.5,
  },
  patient: {
    label: "Patient",
    scalpStart: { pct: 1.5, atr: 2.0, progress: 0.8 },
    scalpLocks: [{ atr: 2.5, progress: 0.9, share: 0.5 }],
    scalpFloor: 0.0018,
    runnerStart: { pct: 1.8, atr: 2.5, progress: 0.75 },
    runnerTrailAtr: 2.5,
    runnerFloor: 0.002,
    runnerExtend: 2.0,
  },
  fixed: {
    label: "Fixed stop and target",
    scalpStart: { pct: Infinity, atr: Infinity, progress: Infinity },
    scalpLocks: [],
    scalpFloor: 0,
    runnerStart: { pct: Infinity, atr: Infinity, progress: Infinity },
    runnerTrailAtr: 0,
    runnerFloor: 0,
    runnerExtend: 0,
    fixed: true,
  },
};

export const DEFAULT_TRAIL_PROFILE: TrailProfileId = "tight";

export function trailProfile(id: string | undefined): TrailProfile {
  return TRAIL_PROFILES[(id as TrailProfileId) in TRAIL_PROFILES ? (id as TrailProfileId) : DEFAULT_TRAIL_PROFILE];
}

/** Trend, breakout and swing trades trail as runners (the app sets trailMode to match). */
export function isTrendRunner(p: Pick<TrailState, "trailMode" | "family" | "expectedHoldingTimeMinutes">): boolean {
  return (
    p.trailMode === "TREND_RUNNER" ||
    p.family === "trend_following" ||
    p.family === "breakout_confirmation" ||
    (p.expectedHoldingTimeMinutes || 30) > 60
  );
}

/**
 * Moves the price extremes, trailing state, stop and (for runners past the
 * first target) the target for a new price, by the position's trail profile.
 * Stops only ever tighten. Mutates `p`; returns true if the stop or target moved.
 */
export function updateTrailingStop(p: TrailState, price: number): boolean {
  const base = trailProfile(p.trailProfile);
  // Stocks (Indian or US): a trailing stop never sits closer to entry than their costs.
  const stockBuffer = isNseSymbol(p.symbol) ? NSE_BREAKEVEN_BUFFER : isUsSymbol(p.symbol) ? US_BREAKEVEN_BUFFER : null;
  const cfg = stockBuffer !== null && !base.fixed
    ? { ...base, scalpFloor: Math.max(base.scalpFloor, stockBuffer), runnerFloor: Math.max(base.runnerFloor, stockBuffer) }
    : base;
  const isLong = p.direction === "LONG";
  const entry = p.entryPrice;
  const atr = p.atrAtEntry || entry * 0.005;
  const runner = isTrendRunner(p);
  const initialTP = p.initialTakeProfit || p.takeProfit;
  // Direction-aware helpers: "up" means in the trade's favour.
  const dir = isLong ? 1 : -1;
  const better = (a: number, b: number) => (isLong ? Math.max(a, b) : Math.min(a, b));
  const tighter = (candidate: number) => (isLong ? candidate > p.stopLoss : candidate < p.stopLoss);

  if (isLong) p.highestPrice = Math.max(p.highestPrice || entry, price);
  else p.lowestPrice = Math.min(p.lowestPrice || entry, price);
  if (cfg.fixed) return false;
  const best = isLong ? p.highestPrice! : p.lowestPrice!;
  const peakGain = Math.max(0, (best - entry) * dir);
  const profitInATR = atr > 0 ? peakGain / atr : 0;
  const profitPct = (peakGain / entry) * 100;
  const targetDist = Math.max(0.001, (initialTP - entry) * dir);
  const targetProgress = peakGain / targetDist;
  const started = (s: { pct: number; atr: number; progress: number }) =>
    profitPct >= s.pct || profitInATR >= s.atr || targetProgress >= s.progress;

  let changed = false;
  const moveStop = (candidate: number) => {
    if (tighter(candidate)) {
      p.stopLoss = candidate;
      changed = true;
    }
  };

  if (runner) {
    if (!p.trailActive && started(cfg.runnerStart)) p.trailActive = true;
    if (!p.trailActive) return changed;
    const trail = best - dir * atr * cfg.runnerTrailAtr;
    if ((price - initialTP) * dir >= 0) {
      // Past the first target: lock the stop there, extend the target, and
      // keep trailing behind the best price.
      moveStop(initialTP);
      const extended = initialTP + dir * targetDist * cfg.runnerExtend;
      if ((extended - p.takeProfit) * dir > 0) {
        p.takeProfit = extended;
        changed = true;
      }
      moveStop(better(initialTP, trail));
    } else {
      moveStop(better(entry * (1 + dir * cfg.runnerFloor), trail));
    }
    return changed;
  }

  if (!p.trailActive && started(cfg.scalpStart)) p.trailActive = true;
  if (!p.trailActive) return changed;
  let lockedGain = entry * cfg.scalpFloor;
  const lock = cfg.scalpLocks.find((l) => profitInATR >= l.atr || targetProgress >= l.progress);
  if (lock) lockedGain = Math.max(lockedGain, peakGain * lock.share);
  moveStop(better(entry * (1 + dir * cfg.scalpFloor), entry + dir * lockedGain));
  return changed;
}

/** Whether `price` closes the position, and why. */
export function exitAt(p: Pick<TrailState, "direction" | "entryPrice" | "stopLoss" | "takeProfit" | "trailActive">, price: number): TrailExitReason | null {
  if (p.direction === "LONG") {
    if (price >= p.takeProfit) return "TAKE_PROFIT";
    if (price <= p.stopLoss) return p.trailActive || p.stopLoss >= p.entryPrice ? "TRAILING_STOP" : "STOP_LOSS";
  } else {
    if (price <= p.takeProfit) return "TAKE_PROFIT";
    if (price >= p.stopLoss) return p.trailActive || p.stopLoss <= p.entryPrice ? "TRAILING_STOP" : "STOP_LOSS";
  }
  return null;
}

export type GuardFields = Pick<TrailState, "stopLoss" | "takeProfit" | "highestPrice" | "lowestPrice" | "trailActive"> & {
  bankedQuantity?: number;
  bankedPrice?: number;
};

/**
 * Combines two copies of a position's guard state (the server's and the
 * browser's), keeping whichever is further along: the more protective stop,
 * the further target (a runner's extension only ever moves it out), the
 * wider price extremes, trailing once either side started, and the first
 * banked fill.
 */
export function mergeGuardState(direction: "LONG" | "SHORT", entryPrice: number, a: GuardFields | undefined, b: GuardFields): GuardFields {
  const high = b.highestPrice || entryPrice;
  const low = b.lowestPrice || entryPrice;
  if (!a) {
    return {
      stopLoss: b.stopLoss,
      takeProfit: b.takeProfit,
      highestPrice: high,
      lowestPrice: low,
      trailActive: b.trailActive ?? false,
      bankedQuantity: b.bankedQuantity,
      bankedPrice: b.bankedPrice,
    };
  }
  const isLong = direction === "LONG";
  const pick = (x: number, y: number, further: boolean) => {
    const vals = [x, y].filter((v) => Number.isFinite(v));
    if (vals.length === 0) return y;
    return (isLong ? further : !further) ? Math.max(...vals) : Math.min(...vals);
  };
  const banked = (a.bankedQuantity ?? 0) > 0 ? a : b;
  return {
    stopLoss: pick(a.stopLoss, b.stopLoss, true),
    takeProfit: pick(a.takeProfit, b.takeProfit, true),
    highestPrice: a.highestPrice ? Math.max(a.highestPrice, high) : high,
    lowestPrice: a.lowestPrice ? Math.min(a.lowestPrice, low) : low,
    trailActive: Boolean(a.trailActive || b.trailActive),
    bankedQuantity: banked.bankedQuantity,
    bankedPrice: banked.bankedPrice,
  };
}
