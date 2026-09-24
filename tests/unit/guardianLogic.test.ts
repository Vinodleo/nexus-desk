import { describe, expect, it } from "vitest";
import { applyGuardianTick, isPastHoldingTime, mergeSyncedGuardState, type GuardedPosition } from "../../server/guardianLogic";

const base = (over: Partial<GuardedPosition> = {}): GuardedPosition => ({
  direction: "LONG",
  entryPrice: 1000,
  currentPrice: 1000,
  stopLoss: 990,
  takeProfit: 1050,
  quantity: 1,
  atrAtEntry: 10,
  trailMode: "SCALP_TIGHT",
  openTime: new Date().toISOString(),
  ...over,
});

describe("applyGuardianTick — LONG", () => {
  it("does nothing inside the range", () => {
    const p = base();
    expect(applyGuardianTick(p, 1002)).toBeNull();
    expect(p.trailActive).toBeFalsy();
    expect(p.stopLoss).toBe(990);
    expect(p.highestPrice).toBe(1002);
    expect(p.currentPrice).toBe(1002);
  });

  it("hits take-profit", () => {
    expect(applyGuardianTick(base(), 1050)).toBe("TAKE_PROFIT");
  });

  it("hits the original stop as STOP_LOSS", () => {
    expect(applyGuardianTick(base(), 990)).toBe("STOP_LOSS");
  });

  it("activates the scalp trail at 1 ATR and ratchets the stop above breakeven", () => {
    const p = base();
    expect(applyGuardianTick(p, 1010)).toBeNull(); // peak gain 10 = 1.0 ATR
    expect(p.trailActive).toBe(true);
    // 1 ATR & 20% of target -> ratchet 50% of peak gain = 5 -> stop 1005
    expect(p.stopLoss).toBeCloseTo(1005, 6);
  });

  it("never lowers a ratcheted stop, and exits on it as TRAILING_STOP", () => {
    const p = base();
    applyGuardianTick(p, 1040); // peak 40 = 4 ATR, 80% of target -> 70% ratchet = 1028
    expect(p.stopLoss).toBeCloseTo(1028, 6);
    expect(applyGuardianTick(p, 1030)).toBeNull();
    expect(p.stopLoss).toBeCloseTo(1028, 6); // unchanged on a pullback
    expect(applyGuardianTick(p, 1027)).toBe("TRAILING_STOP");
  });

  it("uses the wider 1.5 ATR trail for trend runners", () => {
    const p = base({ trailMode: "TREND_RUNNER", takeProfit: 1200 });
    applyGuardianTick(p, 1007); // 0.7%, 0.7 ATR: not yet active
    expect(p.trailActive).toBeFalsy();
    applyGuardianTick(p, 1030); // 3 ATR: active, stop = max(1002, 1030 - 15) = 1015
    expect(p.trailActive).toBe(true);
    expect(p.stopLoss).toBeCloseTo(1015, 6);
  });

  it("falls back to a 0.5% ATR when none was recorded", () => {
    const p = base({ atrAtEntry: undefined });
    applyGuardianTick(p, 1005); // 0.5% of 1000 = 5 -> 1 ATR
    expect(p.trailActive).toBe(true);
  });
});

describe("applyGuardianTick — SHORT", () => {
  const short = (over: Partial<GuardedPosition> = {}) =>
    base({ direction: "SHORT", stopLoss: 1010, takeProfit: 950, ...over });

  it("hits take-profit below entry", () => {
    expect(applyGuardianTick(short(), 950)).toBe("TAKE_PROFIT");
  });

  it("hits stop above entry", () => {
    expect(applyGuardianTick(short(), 1010)).toBe("STOP_LOSS");
  });

  it("ratchets the stop down and exits on it", () => {
    const p = short();
    applyGuardianTick(p, 960); // peak gain 40 = 4 ATR -> 70% ratchet -> stop 972
    expect(p.stopLoss).toBeCloseTo(972, 6);
    expect(p.lowestPrice).toBe(960);
    expect(applyGuardianTick(p, 973)).toBe("TRAILING_STOP");
  });
});

describe("isPastHoldingTime", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  const opened = (minsAgo: number) => new Date(now - minsAgo * 60000).toISOString();

  it("defaults to 30 minutes", () => {
    expect(isPastHoldingTime(base({ openTime: opened(29) }), now)).toBe(false);
    expect(isPastHoldingTime(base({ openTime: opened(30) }), now)).toBe(true);
  });

  it("honours a custom holding time (swing = 3 days)", () => {
    expect(isPastHoldingTime(base({ openTime: opened(60), expectedHoldingTimeMinutes: 4320 }), now)).toBe(false);
    expect(isPastHoldingTime(base({ openTime: opened(4320), expectedHoldingTimeMinutes: 4320 }), now)).toBe(true);
  });
});

describe("mergeSyncedGuardState", () => {
  const TP = 1050;
  const server = { stopLoss: 1000, takeProfit: 1050, highestPrice: 1040, lowestPrice: 995, trailActive: true };

  it("adopts the browser's tighter LONG stop", () => {
    expect(mergeSyncedGuardState("LONG", 1000, server, { stopLoss: 1020, takeProfit: TP }).stopLoss).toBe(1020);
  });

  it("never loosens the guardian's LONG stop", () => {
    expect(mergeSyncedGuardState("LONG", 1000, server, { stopLoss: 990, takeProfit: TP }).stopLoss).toBe(1000);
  });

  it("mirrors for SHORT: the lower stop is tighter", () => {
    const shortServer = { stopLoss: 1010, takeProfit: 950 };
    expect(mergeSyncedGuardState("SHORT", 1000, shortServer, { stopLoss: 1002, takeProfit: TP }).stopLoss).toBe(1002);
    expect(mergeSyncedGuardState("SHORT", 1000, shortServer, { stopLoss: 1030, takeProfit: TP }).stopLoss).toBe(1010);
  });

  it("only widens price extremes and never switches trailing off", () => {
    const r = mergeSyncedGuardState("LONG", 1000, server, { stopLoss: 1000, takeProfit: TP, highestPrice: 1030, lowestPrice: 990, trailActive: false });
    expect(r).toMatchObject({ highestPrice: 1040, lowestPrice: 990, trailActive: true });
  });

  it("takes the browser's values for a position the guardian hasn't seen", () => {
    expect(mergeSyncedGuardState("LONG", 1000, undefined, { stopLoss: 985, takeProfit: TP })).toMatchObject({
      stopLoss: 985, takeProfit: TP, highestPrice: 1000, lowestPrice: 1000, trailActive: false,
    });
  });
});
