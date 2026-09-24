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
}

export type TrailExitReason = "TAKE_PROFIT" | "STOP_LOSS" | "TRAILING_STOP";

/** Stop past entry that covers CoinDCX's 0.10% round-trip fees plus spread. */
const SCALP_FLOOR = 0.0018;
/** A runner's break-even floor. */
const RUNNER_FLOOR = 0.002;

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
 * first target) the target for a new price. Stops only ever tighten.
 * Mutates `p`; returns true if the stop or target moved.
 */
export function updateTrailingStop(p: TrailState, price: number): boolean {
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
  const best = isLong ? p.highestPrice! : p.lowestPrice!;
  const peakGain = Math.max(0, (best - entry) * dir);
  const profitInATR = atr > 0 ? peakGain / atr : 0;
  const profitPct = (peakGain / entry) * 100;
  const targetDist = Math.max(0.001, (initialTP - entry) * dir);
  const targetProgress = peakGain / targetDist;

  let changed = false;
  const moveStop = (candidate: number) => {
    if (tighter(candidate)) {
      p.stopLoss = candidate;
      changed = true;
    }
  };

  if (runner) {
    if (!p.trailActive && (profitPct >= 0.8 || profitInATR >= 1.2 || targetProgress >= 0.5)) p.trailActive = true;
    if (!p.trailActive) return changed;
    if ((price - initialTP) * dir >= 0) {
      // Past the first target: lock the stop there, extend the target, and
      // keep trailing 1.5 ATR behind the best price.
      moveStop(initialTP);
      const extended = initialTP + dir * targetDist * 1.5;
      if ((extended - p.takeProfit) * dir > 0) {
        p.takeProfit = extended;
        changed = true;
      }
      moveStop(better(initialTP, best - dir * atr * 1.5));
    } else {
      moveStop(better(entry * (1 + dir * RUNNER_FLOOR), best - dir * atr * 1.5));
    }
    return changed;
  }

  if (!p.trailActive && (profitPct >= 0.6 || profitInATR >= 1.0 || targetProgress >= 0.4)) p.trailActive = true;
  if (!p.trailActive) return changed;
  let lockedGain = entry * SCALP_FLOOR;
  if (profitInATR >= 1.8 || targetProgress >= 0.75) lockedGain = Math.max(lockedGain, peakGain * 0.7);
  else if (profitInATR >= 1.0 || targetProgress >= 0.5) lockedGain = Math.max(lockedGain, peakGain * 0.5);
  moveStop(better(entry * (1 + dir * SCALP_FLOOR), entry + dir * lockedGain));
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
