// Guardian stop/target/trailing logic for one position on one price tick.
// Pure apart from mutating the position's high/low watermarks, trailing state
// and ratcheted stop — kept separate from server.ts so it can be unit-tested.

export type GuardianExitReason = "TAKE_PROFIT" | "STOP_LOSS" | "TRAILING_STOP" | "EXPIRY_TIME";

export interface GuardedPosition {
  direction: "LONG" | "SHORT";
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  takeProfit: number;
  highestPrice?: number;
  lowestPrice?: number;
  trailActive?: boolean;
  atrAtEntry?: number;
  trailMode?: "SCALP_TIGHT" | "TREND_RUNNER";
  openTime: string;
  expectedHoldingTimeMinutes?: number;
}

// Returns the exit reason if this tick closes the position, else null.
export function applyGuardianTick(pos: GuardedPosition, currentPrice: number): GuardianExitReason | null {
  const isLong = pos.direction === "LONG";
  pos.currentPrice = currentPrice;

  if (!pos.highestPrice) pos.highestPrice = pos.entryPrice;
  if (!pos.lowestPrice) pos.lowestPrice = pos.entryPrice;

  if (currentPrice > pos.highestPrice) pos.highestPrice = currentPrice;
  if (currentPrice < pos.lowestPrice) pos.lowestPrice = currentPrice;

  const entryPrice = pos.entryPrice;
  const atr = pos.atrAtEntry || entryPrice * 0.005;

  let hitExit = false;
  let exitReason: "TAKE_PROFIT" | "STOP_LOSS" | "TRAILING_STOP" | "EXPIRY_TIME" | null = null;

  if (isLong) {
    const peakGain = pos.highestPrice - entryPrice;
    const profitPct = ((currentPrice - entryPrice) / entryPrice) * 100;
    const profitInATR = peakGain / (atr || 1);
    const targetDist = Math.max(0.0001, pos.takeProfit - entryPrice);
    const targetProgress = peakGain / targetDist;

    if (pos.trailMode === "TREND_RUNNER") {
      if (!pos.trailActive && (profitInATR >= 1.2 || targetProgress >= 0.50)) {
        pos.trailActive = true;
      }
      if (pos.trailActive) {
        const step1DynamicStop = Math.max(entryPrice * 1.002, pos.highestPrice - 1.5 * atr);
        if (step1DynamicStop > pos.stopLoss) pos.stopLoss = step1DynamicStop;
      }
    } else {
      if (!pos.trailActive && (profitPct >= 0.60 || profitInATR >= 1.0 || targetProgress >= 0.40)) {
        pos.trailActive = true;
      }
      if (pos.trailActive) {
        const breakevenFloor = entryPrice * 1.0018;
        let ratchetGain = entryPrice * 0.0018;
        if (profitInATR >= 1.8 || targetProgress >= 0.75) {
          ratchetGain = Math.max(ratchetGain, peakGain * 0.70);
        } else if (profitInATR >= 1.0 || targetProgress >= 0.50) {
          ratchetGain = Math.max(ratchetGain, peakGain * 0.50);
        }
        const dynamicStop = Math.max(breakevenFloor, entryPrice + ratchetGain);
        if (dynamicStop > pos.stopLoss) pos.stopLoss = dynamicStop;
      }
    }

    if (currentPrice >= pos.takeProfit) {
      hitExit = true;
      exitReason = "TAKE_PROFIT";
    } else if (currentPrice <= pos.stopLoss) {
      hitExit = true;
      exitReason = pos.trailActive || pos.stopLoss >= entryPrice ? "TRAILING_STOP" : "STOP_LOSS";
    }
  } else {
    // Short
    const peakGain = entryPrice - pos.lowestPrice;
    const profitPct = ((entryPrice - currentPrice) / entryPrice) * 100;
    const profitInATR = peakGain / (atr || 1);
    const targetDist = Math.max(0.0001, entryPrice - pos.takeProfit);
    const targetProgress = peakGain / targetDist;

    if (pos.trailMode === "TREND_RUNNER") {
      if (!pos.trailActive && (profitInATR >= 1.2 || targetProgress >= 0.50)) {
        pos.trailActive = true;
      }
      if (pos.trailActive) {
        const step1DynamicStop = Math.min(entryPrice * 0.998, pos.lowestPrice + 1.5 * atr);
        if (step1DynamicStop < pos.stopLoss) pos.stopLoss = step1DynamicStop;
      }
    } else {
      if (!pos.trailActive && (profitPct >= 0.60 || profitInATR >= 1.0 || targetProgress >= 0.40)) {
        pos.trailActive = true;
      }
      if (pos.trailActive) {
        const breakevenCeiling = entryPrice * 0.9982;
        let ratchetGain = entryPrice * 0.0018;
        if (profitInATR >= 1.8 || targetProgress >= 0.75) {
          ratchetGain = Math.max(ratchetGain, peakGain * 0.70);
        } else if (profitInATR >= 1.0 || targetProgress >= 0.50) {
          ratchetGain = Math.max(ratchetGain, peakGain * 0.50);
        }
        const dynamicStop = Math.min(breakevenCeiling, entryPrice - ratchetGain);
        if (dynamicStop < pos.stopLoss) pos.stopLoss = dynamicStop;
      }
    }

    if (currentPrice <= pos.takeProfit) {
      hitExit = true;
      exitReason = "TAKE_PROFIT";
    } else if (currentPrice >= pos.stopLoss) {
      hitExit = true;
      exitReason = pos.trailActive || pos.stopLoss <= entryPrice ? "TRAILING_STOP" : "STOP_LOSS";
    }
  }

  return hitExit ? exitReason : null;
}

// Max holding time; positions without one default to 30 minutes.
export function isPastHoldingTime(pos: GuardedPosition, nowMs: number = Date.now()): boolean {
  const openedMs = pos.openTime ? new Date(pos.openTime).getTime() : nowMs;
  const elapsedMinutes = (nowMs - openedMs) / 60000;
  return elapsedMinutes >= (pos.expectedHoldingTimeMinutes || 30);
}

// Merge the browser's copy of a position into the guardian's on sync.
//
// Both sides trail stops independently (the browser also locks the stop at
// the initial target for trend runners), so either may hold the tighter one.
// Keep whichever stop is more protective — higher for a LONG, lower for a
// SHORT — so the guardian honours the browser's tightening without ever
// loosening its own. Price extremes and trailing state only ever widen too.
export function mergeSyncedGuardState(
  direction: "LONG" | "SHORT",
  entryPrice: number,
  existing: Pick<GuardedPosition, "stopLoss" | "highestPrice" | "lowestPrice" | "trailActive"> | undefined,
  incoming: Pick<GuardedPosition, "stopLoss" | "highestPrice" | "lowestPrice" | "trailActive">
): Pick<GuardedPosition, "stopLoss" | "highestPrice" | "lowestPrice" | "trailActive"> {
  const incomingHigh = incoming.highestPrice || entryPrice;
  const incomingLow = incoming.lowestPrice || entryPrice;
  if (!existing) {
    return {
      stopLoss: incoming.stopLoss,
      highestPrice: incomingHigh,
      lowestPrice: incomingLow,
      trailActive: incoming.trailActive ?? false,
    };
  }
  const stops = [existing.stopLoss, incoming.stopLoss].filter((s) => Number.isFinite(s));
  const stopLoss =
    stops.length === 0 ? incoming.stopLoss : direction === "LONG" ? Math.max(...stops) : Math.min(...stops);
  return {
    stopLoss,
    highestPrice: existing.highestPrice ? Math.max(existing.highestPrice, incomingHigh) : incomingHigh,
    lowestPrice: existing.lowestPrice ? Math.min(existing.lowestPrice, incomingLow) : incomingLow,
    trailActive: Boolean(existing.trailActive || incoming.trailActive),
  };
}
