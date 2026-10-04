import { describe, expect, it } from "vitest";
import { COIN_FEE_PER_SIDE, computeClosedTradePnl } from "../../src/shared/tradeMath";

// Coins pay CoinDCX's INR spot fee: 0.5% of each order plus 18% GST on it,
// 0.59% a side (its order screens, from the live test order).

describe("computeClosedTradePnl", () => {
  it("charges CoinDCX's 0.59% on both legs", () => {
    expect(COIN_FEE_PER_SIDE).toBe(0.0059);
    // LONG 2 @ 1000 -> 990. Gross -20. Fees: 2000*0.0059 + 1980*0.0059 = 23.48
    const r = computeClosedTradePnl("LONG", 1000, 990, 2, "STOP_LOSS");
    expect(r.grossPnl).toBe(-20);
    expect(r.feesPaid).toBe(23.48);
    expect(r.realizedPnl).toBe(-43.48);
    expect(r.realizedPnlPercent).toBe(-2.17);
    expect(r.entryNotional).toBe(2000);
    expect(r.isWin).toBe(false);
  });

  it("matches what CoinDCX charged the test order: ₹1.00 a side on ₹170", () => {
    // Bought 0.00002 BTC at ₹85,00,026.10 (₹170.00, fee ₹0.80 + GST ₹0.20),
    // sold at ₹84,57,500.10 (₹169.15, the same). TDS on the sale isn't a cost.
    const r = computeClosedTradePnl("LONG", 8500026.1, 8457500.1, 0.00002, "MANUAL");
    expect(r.grossPnl).toBe(-0.85);
    expect(r.feesPaid).toBe(2);
    expect(r.realizedPnl).toBe(-2.85);
  });

  it("charges the same on a take-profit exit (no lower rate for limit orders is known)", () => {
    // LONG 1 @ 1000 -> 1100. Fees: 1000*0.0059 + 1100*0.0059 = 12.39
    const r = computeClosedTradePnl("LONG", 1000, 1100, 1, "TAKE_PROFIT");
    expect(r.grossPnl).toBe(100);
    expect(r.feesPaid).toBe(12.39);
    expect(r.realizedPnl).toBe(87.61);
    expect(r.isWin).toBe(true);
  });

  it("computes SHORT P&L from entry minus exit", () => {
    const r = computeClosedTradePnl("SHORT", 1000, 950, 1, "MANUAL");
    expect(r.grossPnl).toBe(50);
    expect(r.feesPaid).toBe(11.5); // 5.9 + 5.605
    expect(r.realizedPnl).toBe(38.5);
  });

  it("treats a flat trade as a loss after fees", () => {
    const r = computeClosedTradePnl("LONG", 1000, 1000, 1, "EXPIRY_TIME");
    expect(r.grossPnl).toBe(0);
    expect(r.realizedPnl).toBe(-11.8);
    expect(r.isWin).toBe(false);
  });
});
