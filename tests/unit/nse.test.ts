import { describe, expect, it } from "vitest";
import { isNseOpen, isNseSymbol, nseRoundTripRate, nseSquareOffDue, nseTakesEntries, nseTradeCosts } from "../../src/shared/nse";
import { computeClosedTradePnl } from "../../src/shared/tradeMath";
import { bankPartial, holdingDecision, stopLocksProfit } from "../../src/shared/exitRules";
import { updateTrailingStop } from "../../src/shared/trailingStop";

// Indian stocks: NSE hours, the 3:20 square-off, and Angel One's costs.

/** A time in IST on Wednesday 23 September 2026. */
const ist = (hhmm: string, day = "2026-09-23") => Date.parse(`${day}T${hhmm}:00+05:30`);

describe("NSE session", () => {
  it("tells stocks from coins", () => {
    expect(isNseSymbol("SBIN")).toBe(true);
    expect(isNseSymbol("M&M")).toBe(true);
    expect(isNseSymbol("BAJAJ-AUTO")).toBe(true);
    expect(isNseSymbol("BTC/INR")).toBe(false);
    expect(isNseSymbol(undefined)).toBe(false);
  });

  it("is open 9:15 to 3:30 on weekdays, and takes new trades until 3:00", () => {
    expect(isNseOpen(ist("09:14"))).toBe(false);
    expect(isNseOpen(ist("09:15"))).toBe(true);
    expect(nseTakesEntries(ist("14:59"))).toBe(true);
    expect(nseTakesEntries(ist("15:00"))).toBe(false);
    expect(isNseOpen(ist("15:29"))).toBe(true);
    expect(isNseOpen(ist("15:30"))).toBe(false);
    // Saturday.
    expect(isNseOpen(ist("11:00", "2026-09-26"))).toBe(false);
  });

  it("squares off at 3:20, and anything left from an earlier day", () => {
    const opened = new Date(ist("13:00")).toISOString();
    expect(nseSquareOffDue(opened, ist("15:19"))).toBe(false);
    expect(nseSquareOffDue(opened, ist("15:20"))).toBe(true);
    expect(nseSquareOffDue(opened, ist("09:30", "2026-09-24"))).toBe(true);
  });

  it("closes a stock position at 3:20 even while it's winning; coins run on", () => {
    const pos = { direction: "LONG" as const, entryPrice: 100, stopLoss: 101, quantity: 10, openTime: new Date(ist("15:05")).toISOString(), expectedHoldingTimeMinutes: 30 };
    expect(holdingDecision({ ...pos, symbol: "SBIN" }, ist("15:19"))).toBe("hold");
    expect(holdingDecision({ ...pos, symbol: "SBIN" }, ist("15:20"))).toBe("expire");
    expect(holdingDecision({ ...pos, symbol: "BTC/INR" }, ist("15:20"))).toBe("hold");
  });
});

describe("Angel One intraday costs", () => {
  it("charges brokerage per order (0.1%, at most ₹20, at least ₹5), STT on the sell, stamp on the buy, and GST", () => {
    // ₹10,000 each way: brokerage ₹10 + ₹10, STT ₹2.50, stamp ₹0.30,
    // exchange ₹0.70, SEBI ₹0.02, GST 18% of (₹20 + ₹0.70 + ₹0.02).
    const cost = nseTradeCosts([{ side: "BUY", value: 10000 }, { side: "SELL", value: 10000 }]);
    expect(cost).toBeCloseTo(20 + 2.5 + 0.3 + 0.7 + 0.02 + 0.18 * 20.72, 2);
    // Big orders: brokerage capped at ₹20 each.
    expect(nseTradeCosts([{ side: "BUY", value: 100000 }])).toBeCloseTo(20 + 3 + 3.5 + 0.1 + 0.18 * 23.6, 2);
    // Tiny orders: ₹5 minimum.
    expect(nseTradeCosts([{ side: "BUY", value: 1000 }])).toBeGreaterThan(5);
    expect(nseRoundTripRate(10000)).toBeGreaterThan(0.002);
  });

  it("are what a closed stock trade pays; coins keep CoinDCX's fees", () => {
    const stock = computeClosedTradePnl("LONG", 100, 102, 100, "TAKE_PROFIT", undefined, "SBIN");
    expect(stock.grossPnl).toBe(200);
    expect(stock.feesPaid).toBeCloseTo(nseTradeCosts([{ side: "BUY", value: 10000 }, { side: "SELL", value: 10200 }]), 2);
    const coin = computeClosedTradePnl("LONG", 100, 102, 100, "TAKE_PROFIT");
    expect(coin.feesPaid).toBeCloseTo(10000 * 0.0005 + 10200 * 0.0002, 2);
    // A banked half is its own order.
    const banked = computeClosedTradePnl("LONG", 100, 103, 100, "TRAILING_STOP", { quantity: 50, price: 101 }, "SBIN");
    expect(banked.feesPaid).toBeCloseTo(
      nseTradeCosts([{ side: "BUY", value: 10000 }, { side: "SELL", value: 5150 }, { side: "SELL", value: 5050 }]),
      2
    );
  });

  it("keep a stock's break-even and trailing stops further past entry", () => {
    const pos = { direction: "LONG" as const, entryPrice: 100, stopLoss: 99, quantity: 10, openTime: "", partialQuantity: 5 };
    expect(bankPartial({ ...pos, symbol: "SBIN" }, 101).stopLoss).toBeCloseTo(100.3, 6);
    expect(bankPartial({ ...pos, symbol: "BTC/INR" }, 101).stopLoss).toBeCloseTo(100.18, 6);
    expect(stopLocksProfit({ symbol: "SBIN", direction: "LONG", entryPrice: 100, stopLoss: 100.2 })).toBe(false);
    expect(stopLocksProfit({ symbol: "BTC/INR", direction: "LONG", entryPrice: 100, stopLoss: 100.2 })).toBe(true);

    const trail = (symbol: string) => {
      const p = { symbol, direction: "LONG" as const, entryPrice: 100, stopLoss: 99, takeProfit: 102, atrAtEntry: 1, trailMode: "SCALP_TIGHT" as const };
      updateTrailingStop(p, 100.65);
      return p.stopLoss;
    };
    // Trailing starts at +0.6%; before any lock-in, the stop sits at the cost floor.
    expect(trail("SBIN")).toBeCloseTo(100.3, 6);
    expect(trail("BTC/INR")).toBeCloseTo(100.18, 6);
  });
});
