import { describe, expect, it } from "vitest";
import { FUNDS, isFundSymbol } from "../../src/shared/funds";
import { cleanMarketLimits, DEFAULT_MARKET_LIMITS, openInSlots, slotKindOf, slotsFor, slotTradesLabel } from "../../src/shared/marketLimits";
import { paperScore, PAPER_STRATEGIES, strategyOf } from "../../src/services/paperScorecard";
import { weeklySummaryMessage } from "../../server/weeklySummary";

// Breakout 55/20 on funds of gold, bonds and the rest (paper): the same
// trades as US breakout's, on slots of their own and scored on their own.

describe("the funds", () => {
  it("are 16 US-listed funds across kinds of assets", () => {
    expect(FUNDS).toHaveLength(16);
    expect(FUNDS).toEqual(expect.arrayContaining(["GLD", "SLV", "TLT", "IEF", "DBC", "UUP"]));
    expect(isFundSymbol("GLD.US")).toBe(true);
    expect(isFundSymbol("AAPL.US")).toBe(false);
    expect(isFundSymbol("GLD")).toBe(false);
    expect(isFundSymbol(undefined)).toBe(false);
  });

  it("take their own slots in the US limits: 3 until chosen, none for coins or Indian stocks", () => {
    expect(slotKindOf({ strategy: "breakout", symbol: "GLD.US" })).toBe("funds");
    expect(slotKindOf({ strategy: "breakout", symbol: "AAPL.US" })).toBe("breakout");
    expect(slotKindOf({ strategy: "momentum", symbol: "QQQ.US" })).toBe("momentum");
    expect(slotKindOf({ symbol: "GLD.US" })).toBeNull();
    expect(DEFAULT_MARKET_LIMITS.us.fundsTrades).toBe(3);
    expect(DEFAULT_MARKET_LIMITS.coins.fundsTrades).toBe(0);
    const limits = cleanMarketLimits({ us: { amountPerTradeInr: 100000, maxOpenTrades: 2, fundsTrades: 5 } });
    expect(limits.us.fundsTrades).toBe(5);
    expect(slotsFor(limits.us, "funds")).toBe(5);
    expect(slotsFor(limits.us, "breakout")).toBe(3);
    // Limits saved before the funds: their default.
    expect(cleanMarketLimits({ us: { amountPerTradeInr: 5000, maxOpenTrades: 2 } }).us.fundsTrades).toBe(3);
    expect(cleanMarketLimits({ us: { amountPerTradeInr: 5000, maxOpenTrades: 2, fundsTrades: 99 } }).us.fundsTrades).toBe(3);
    const open = [
      { symbol: "GLD.US", strategy: "breakout" },
      { symbol: "AAPL.US", strategy: "breakout" },
      { symbol: "MSFT.US", strategy: "momentum" },
    ];
    expect(openInSlots(open, "TLT.US", "funds").map((p) => p.symbol)).toEqual(["GLD.US"]);
    expect(openInSlots(open, "NVDA.US", "breakout").map((p) => p.symbol)).toEqual(["AAPL.US"]);
    expect(slotTradesLabel("us", "funds")).toBe("funds breakout");
    expect(slotTradesLabel("us", "breakout")).toBe("US stock breakout");
    expect(slotTradesLabel("coins", null)).toBe("coin");
  });

  it("are scored on their own, apart from US stocks' breakout", () => {
    expect(PAPER_STRATEGIES.map((s) => s.id)).toContain("fundsBreakout");
    expect(strategyOf({ symbol: "GLD.US", strategy: "breakout" })).toBe("fundsBreakout");
    expect(strategyOf({ symbol: "AAPL.US", strategy: "breakout" })).toBe("usBreakout");
    const trade = (symbol: string, realizedPnl: number) =>
      ({ id: symbol, symbol, strategy: "breakout", direction: "LONG", entryPrice: 1, exitPrice: 1, quantity: 1, moneyPlaced: 1, realizedPnl, realizedPnlPercent: 0, isWin: realizedPnl > 0, exitReason: "TRAILING_STOP", openedAt: "", closedAt: new Date(Date.parse("2026-10-10T00:00:00Z")).toISOString(), riskAtOpen: 100 }) as any;
    const trades = [trade("GLD.US", 200), trade("AAPL.US", -100)];
    expect(paperScore("fundsBreakout", trades, [], null)).toMatchObject({ closed: 1, avgR: 2 });
    expect(paperScore("usBreakout", trades, [], null)).toMatchObject({ closed: 1, avgR: -1 });
    // The Sunday pop-up names them apart.
    const msg = weeklySummaryMessage(trades, [], { usBreakout: 0.39, fundsBreakout: 0.54 }, Date.parse("2026-10-11T05:00:00Z"))!;
    expect(msg.body).toContain("US breakout: 1 closed so far, −1.00R a trade (replay +0.39R).");
    expect(msg.body).toContain("Funds breakout: 1 closed so far, +2.00R a trade (replay +0.54R).");
  });
});
