import { describe, expect, it } from "vitest";
import {
  BREAKEVEN_BUFFER,
  bankPartial,
  blendedExitPrice,
  holdingDecision,
  openQuantity,
  partialDue,
  planPartialQuantity,
  type ExitState,
} from "../../src/shared/exitRules";
import { MAKER_FEE_RATE, TAKER_FEE_RATE, computeClosedTradePnl } from "../../src/shared/tradeMath";
import { applyTickToPosition } from "../../src/services/positionTick";
import { applyGuardianTick, isPastHoldingTime, mergeSyncedGuardState } from "../../server/guardianLogic";
import type { Position } from "../../src/types";

const MIN = 60_000;
const opened = (minutesAgo: number) => new Date(Date.now() - minutesAgo * MIN).toISOString();

// Long from 1000, stop 990 (1R = 10), target 1020, 2 units with 1 to bank.
const state = (over: Partial<ExitState> = {}): ExitState => ({
  direction: "LONG",
  entryPrice: 1000,
  stopLoss: 990,
  initialStopLoss: 990,
  quantity: 2,
  partialQuantity: 1,
  openTime: opened(0),
  expectedHoldingTimeMinutes: 30,
  ...over,
});

describe("the time limit", () => {
  it("closes a trade that hasn't worked, and lets a locked-in winner run", () => {
    expect(holdingDecision(state({ openTime: opened(10) }))).toBe("hold");
    expect(holdingDecision(state({ openTime: opened(31) }))).toBe("expire");
    const locked = state({ openTime: opened(31), stopLoss: 1000 * (1 + BREAKEVEN_BUFFER) });
    expect(holdingDecision(locked)).toBe("hold");
    // Break-even isn't enough: fees would make it a loss.
    expect(holdingDecision(state({ openTime: opened(31), stopLoss: 1000 }))).toBe("expire");
  });

  it("closes even a winner at three times the limit", () => {
    expect(holdingDecision(state({ openTime: opened(91), stopLoss: 1010 }))).toBe("expire");
  });

  it("mirrors for shorts", () => {
    const short = { direction: "SHORT" as const, stopLoss: 1000 * (1 - BREAKEVEN_BUFFER), initialStopLoss: 1010 };
    expect(holdingDecision(state({ ...short, openTime: opened(31) }))).toBe("hold");
    expect(holdingDecision(state({ ...short, stopLoss: 1005, openTime: opened(31) }))).toBe("expire");
  });
});

describe("banking half at +1R", () => {
  it("is due the first time price reaches +1R on a paper position", () => {
    expect(partialDue(state(), 1009.9)).toBe(false);
    expect(partialDue(state(), 1010)).toBe(true);
    expect(partialDue(state({ isLiveOrder: true }), 1010)).toBe(false);
    expect(partialDue(state({ bankedQuantity: 1, bankedPrice: 1010 }), 1015)).toBe(false);
    expect(partialDue(state({ initialStopLoss: undefined }), 1010)).toBe(false);
    expect(partialDue(state({ partialQuantity: undefined }), 1010)).toBe(false);
    expect(partialDue(state({ direction: "SHORT", stopLoss: 1010, initialStopLoss: 1010 }), 990)).toBe(true);
  });

  it("moves the stop past break-even, never backwards", () => {
    expect(bankPartial(state(), 1010)).toEqual({ bankedQuantity: 1, bankedPrice: 1010, stopLoss: 1000 * (1 + BREAKEVEN_BUFFER) });
    expect(bankPartial(state({ stopLoss: 1005 }), 1010).stopLoss).toBe(1005);
  });

  it("averages the exit over both halves and counts only the open half as exposure", () => {
    const banked = state({ bankedQuantity: 1, bankedPrice: 1010 });
    expect(blendedExitPrice(banked, 1030)).toBe(1020);
    expect(blendedExitPrice(state(), 1030)).toBe(1030);
    expect(openQuantity(banked)).toBe(1);
  });

  it("plans half only when both halves can trade on their own", () => {
    const rule = { quantityStep: 0.001, quantityPrecision: 3, minQuantity: 0.001, minNotional: 50 };
    expect(planPartialQuantity(0.0151, 10000, rule)).toBe(0.007); // floored to the step: ₹70 banked, ₹81 left
    // A ₹75 minimum order: the ₹70 half couldn't be sold on its own.
    expect(planPartialQuantity(0.0151, 10000, { ...rule, minNotional: 75 })).toBeUndefined();
    expect(planPartialQuantity(1, 100, { quantityStep: 1, quantityPrecision: 0, minQuantity: 1, minNotional: 0 })).toBeUndefined(); // half rounds to 0
  });
});

describe("P&L with a banked half", () => {
  it("adds both halves and charges the banked one the maker rate", () => {
    const pnl = computeClosedTradePnl("LONG", 1000, 1030, 2, "TRAILING_STOP", { quantity: 1, price: 1010 });
    expect(pnl.grossPnl).toBe(40); // +10 on the banked unit, +30 on the other
    expect(pnl.feesPaid).toBeCloseTo(2000 * TAKER_FEE_RATE + 1010 * MAKER_FEE_RATE + 1030 * TAKER_FEE_RATE, 2);
    // Without a banked part it's unchanged.
    expect(computeClosedTradePnl("LONG", 1000, 1030, 2, "TRAILING_STOP").grossPnl).toBe(60);
  });
});

describe("browser tick", () => {
  const position = (over: Partial<Position> = {}): Position => ({
    id: "p1", symbol: "SOL/INR", direction: "LONG", setupName: "t", entryPrice: 1000, currentPrice: 1000, quantity: 2,
    stopLoss: 990, takeProfit: 1030, initialTakeProfit: 1030, initialStopLoss: 990, partialQuantity: 1,
    unrealizedPnl: 0, unrealizedPnlPercent: 0, openTime: opened(1), expectedHoldingTimeMinutes: 30, metaConfidence: 0.6,
    trailMode: "SCALP_TIGHT", atrAtEntry: 10, ...over,
  });

  it("banks half at +1R, then values the position on both halves", () => {
    const out = applyTickToPosition(position(), 1010, new Map(), 1);
    expect(out.kind).toBe("updated");
    if (out.kind !== "updated") return;
    expect(out.banked).toBe(true);
    expect(out.position).toMatchObject({ bankedQuantity: 1, bankedPrice: 1010 });
    expect(out.position.stopLoss).toBeGreaterThanOrEqual(1000 * (1 + BREAKEVEN_BUFFER));
    const later = applyTickToPosition(out.position, 1020, new Map(), 2);
    expect(later.kind === "updated" && later.banked).toBeFalsy(); // only once
    expect(later.kind === "updated" && later.position.unrealizedPnl).toBe(30); // +10 banked, +20 open
  });
});

describe("server guardian", () => {
  const guarded = (over = {}) => ({
    direction: "LONG" as const, entryPrice: 1000, currentPrice: 1000, stopLoss: 990, takeProfit: 1030,
    quantity: 2, initialStopLoss: 990, partialQuantity: 1, atrAtEntry: 10, trailMode: "SCALP_TIGHT" as const,
    openTime: opened(1), expectedHoldingTimeMinutes: 30, ...over,
  });

  it("banks half the same way", () => {
    const pos = guarded();
    expect(applyGuardianTick(pos, 1010)).toBeNull();
    expect(pos).toMatchObject({ bankedQuantity: 1, bankedPrice: 1010 });
    expect(pos.stopLoss).toBeGreaterThanOrEqual(1000 * (1 + BREAKEVEN_BUFFER));
  });

  it("lets a locked-in winner run past the time limit", () => {
    expect(isPastHoldingTime(guarded({ openTime: opened(40), stopLoss: 1005 }))).toBe(false);
    expect(isPastHoldingTime(guarded({ openTime: opened(40) }))).toBe(true);
  });

  it("keeps the first banked fill when the browser syncs", () => {
    const existing = { stopLoss: 1002, bankedQuantity: 1, bankedPrice: 1010 };
    const merged = mergeSyncedGuardState("LONG", 1000, existing, { stopLoss: 990, bankedQuantity: 1, bankedPrice: 1011 });
    expect(merged).toMatchObject({ bankedQuantity: 1, bankedPrice: 1010, stopLoss: 1002 });
    expect(mergeSyncedGuardState("LONG", 1000, { stopLoss: 990 }, { stopLoss: 1002, bankedQuantity: 1, bankedPrice: 1011 })).toMatchObject({
      bankedPrice: 1011,
    });
  });
});
