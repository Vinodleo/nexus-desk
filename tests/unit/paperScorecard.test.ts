import { describe, expect, it } from "vitest";
import type { HistoricalTrade } from "../../src/types";
import { combineRecords, paperScore, strategyOf } from "../../src/services/paperScorecard";

// The Lab's scorecard: each slower strategy's paper trades so far against
// its replay, in R, with its exits, and whether it's within luck's reach.

let k = 0;
function trade(r: number, over: Partial<HistoricalTrade> = {}): HistoricalTrade {
  return {
    id: `t${++k}`, symbol: "SOL/INR", direction: "LONG", setupName: "Breakout 55/20", entryPrice: 100, exitPrice: 100 + r * 10, quantity: 1,
    moneyPlaced: 100, realizedPnl: r * 10, realizedPnlPercent: r * 10, riskAtOpen: 10, isWin: r > 0, exitReason: r > 0 ? "TRAILING_STOP" : "STOP_LOSS",
    openedAt: "", closedAt: "", strategy: "breakout", timeframe: "1d",
    ...over,
  };
}

describe("the paper scorecard", () => {
  it("knows each slower strategy's trades: coin and US breakout, and the daily coin traders", () => {
    expect(strategyOf({ symbol: "SOL/INR", strategy: "breakout" })).toBe("coinBreakout");
    expect(strategyOf({ symbol: "AAPL.US", strategy: "breakout" })).toBe("usBreakout");
    expect(strategyOf({ symbol: "ETH/INR", timeframe: "1d" })).toBe("dailyCoins");
    // The 5-minute traders' aren't on it.
    expect(strategyOf({ symbol: "ETH/INR" })).toBeNull();
    expect(strategyOf({ symbol: "AAPL.US" })).toBeNull();
  });

  it("reads paper trades in R, with their wins, losses, exits, stops that gapped, P&L and open trades", () => {
    const trades = [
      trade(3),
      trade(-1, { exitReason: "STOP_LOSS", stopAtExit: 95, fillAtExit: 93 }),
      trade(-1, { exitReason: "STOP_LOSS", stopAtExit: 95, fillAtExit: 94.9 }),
      trade(2),
      // Not this strategy's, or no risk to read R from: left out.
      trade(5, { symbol: "AAPL.US" }),
      trade(5, { riskAtOpen: undefined }),
    ];
    const score = paperScore("coinBreakout", trades, [{ symbol: "XRP/INR", strategy: "breakout" }, { symbol: "ETH/INR", timeframe: "1d" }], { avgR: 0.98 });
    expect(score).toMatchObject({ closed: 4, open: 1, avgR: 0.75, winPct: 50, avgWinR: 2.5, avgLossR: -1, pnl: 30, gapped: 1, verdict: "early", band: null });
    expect(score.exits).toEqual({ sale: 2, stop: 2 });
  });

  it("sets 10+ trades against the replay: within luck's reach (two standard errors) is in line, past it behind or ahead", () => {
    const mixed = Array.from({ length: 10 }, (_, i) => trade(i % 2 === 0 ? 2 : -1));
    // Mean +0.50R; standard deviation 1.58R, so luck reaches ±1.00R over 10 trades.
    const inLine = paperScore("coinBreakout", mixed, [], { avgR: 0.98 });
    expect(inLine.verdict).toBe("inLine");
    expect(inLine.band).toBeCloseTo(1, 6);
    expect(paperScore("coinBreakout", mixed, [], { avgR: -1 }).verdict).toBe("ahead");
    const losing = [...Array.from({ length: 8 }, () => trade(-1)), trade(0.5), trade(0.5)];
    expect(paperScore("coinBreakout", losing, [], { avgR: 0.98 }).verdict).toBe("behind");
    // Without a replay record, no verdict.
    expect(paperScore("coinBreakout", mixed, [], null).verdict).toBe("early");
  });

  it("puts the trading daily traders' records together, weighted by their trades", () => {
    expect(
      combineRecords([
        { trades: 10, avgR: 0.2, wins: 4, winR: 6, lossR: -4 },
        { trades: 30, avgR: 0, wins: 10, winR: 10, lossR: -10 },
      ])
    ).toEqual({ trades: 40, avgR: 0.05, wins: 14, winR: 16, lossR: -14 });
    expect(combineRecords([])).toBeNull();
  });
});
