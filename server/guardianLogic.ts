// Guardian stop/target/trailing logic for one position on one price tick.
// Pure apart from mutating the position's high/low watermarks, trailing state
// and ratcheted stop — kept separate from server.ts so it can be unit-tested.

import { bankPartial, holdingDecision, partialDue } from "../src/shared/exitRules";
import { exitAt, updateTrailingStop } from "../src/shared/trailingStop";

export type GuardianExitReason = "TAKE_PROFIT" | "STOP_LOSS" | "TRAILING_STOP" | "EXPIRY_TIME";

export interface GuardedPosition {
  /** NSE stocks are squared off at 3:20 IST and trail further past entry. */
  symbol?: string;
  direction: "LONG" | "SHORT";
  entryPrice: number;
  currentPrice: number;
  stopLoss: number;
  takeProfit: number;
  /** The target at open: a trend runner's lock level (shared/trailingStop). */
  initialTakeProfit?: number;
  family?: string;
  trailProfile?: string;
  highestPrice?: number;
  lowestPrice?: number;
  trailActive?: boolean;
  atrAtEntry?: number;
  trailMode?: "SCALP_TIGHT" | "TREND_RUNNER";
  openTime: string;
  expectedHoldingTimeMinutes?: number;
  quantity: number;
  initialStopLoss?: number;
  partialQuantity?: number;
  bankedQuantity?: number;
  bankedPrice?: number;
  isLiveOrder?: boolean;
  /** "1d": a daily-candle trade, closed at its time limit exactly. */
  timeframe?: string;
}

// Returns the exit reason if this tick closes the position, else null.
// Banking half, the trailing stop and the runner's extended target follow
// the same shared rules as the browser book (shared/exitRules,
// shared/trailingStop).
export function applyGuardianTick(pos: GuardedPosition, currentPrice: number): GuardianExitReason | null {
  pos.currentPrice = currentPrice;
  if (!pos.highestPrice) pos.highestPrice = pos.entryPrice;
  if (!pos.lowestPrice) pos.lowestPrice = pos.entryPrice;
  if (currentPrice > pos.highestPrice) pos.highestPrice = currentPrice;
  if (currentPrice < pos.lowestPrice) pos.lowestPrice = currentPrice;

  // First reach of +1R on a paper position: bank half, stop past break-even.
  if (partialDue(pos, currentPrice)) Object.assign(pos, bankPartial(pos, currentPrice));
  updateTrailingStop(pos, currentPrice);
  return exitAt(pos, currentPrice);
}

// Past the holding time (30 minutes by default) and not locked in profit, or
// past the extended limit a winner may run to.
export function isPastHoldingTime(pos: GuardedPosition, nowMs: number = Date.now()): boolean {
  return holdingDecision(pos, nowMs) === "expire";
}
