import { describe, expect, it } from "vitest";
import { computeClosedTradePnl } from "../../src/shared/tradeMath";

describe("computeClosedTradePnl", () => {
  it("charges taker fees on both legs for a stop-loss exit", () => {
    // LONG 2 @ 1000 -> 990. Gross -20. Fees: 2000*0.0005 + 1980*0.0005 = 1.99
    const r = computeClosedTradePnl("LONG", 1000, 990, 2, "STOP_LOSS");
    expect(r.grossPnl).toBe(-20);
    expect(r.feesPaid).toBe(1.99);
    expect(r.realizedPnl).toBe(-21.99);
    expect(r.realizedPnlPercent).toBe(-1.1);
    expect(r.entryNotional).toBe(2000);
    expect(r.isWin).toBe(false);
  });

  it("charges maker fee on a take-profit exit", () => {
    // LONG 1 @ 1000 -> 1100. Fees: 1000*0.0005 + 1100*0.0002 = 0.72
    const r = computeClosedTradePnl("LONG", 1000, 1100, 1, "TAKE_PROFIT");
    expect(r.grossPnl).toBe(100);
    expect(r.feesPaid).toBe(0.72);
    expect(r.realizedPnl).toBe(99.28);
    expect(r.isWin).toBe(true);
  });

  it("computes SHORT P&L from entry minus exit", () => {
    const r = computeClosedTradePnl("SHORT", 1000, 950, 1, "MANUAL");
    expect(r.grossPnl).toBe(50);
    expect(r.feesPaid).toBe(0.98); // 0.5 + 0.475 -> 0.975 rounds to 0.98
    expect(r.realizedPnl).toBe(49.02);
  });

  it("treats a flat trade as a loss after fees", () => {
    const r = computeClosedTradePnl("LONG", 1000, 1000, 1, "EXPIRY_TIME");
    expect(r.grossPnl).toBe(0);
    expect(r.realizedPnl).toBe(-1);
    expect(r.isWin).toBe(false);
  });
});
