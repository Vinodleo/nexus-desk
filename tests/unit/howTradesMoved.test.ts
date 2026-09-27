// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { HowTradesMoved, MIN_EXCURSION_TRADES, excursionSummary, tradeExcursion } from "../../src/components/ledger/LedgerBreakdown";
import type { HistoricalTrade } from "../../src/types";

// How far closed trades went for and against you, in R, and what that says
// about the stop, locking in gains, and the trailing stop.

afterEach(cleanup);

/** A LONG from 100 risking ₹2 a unit (10 units, ₹20 at stake), closing at `exit`, having reached `high` and `low`. */
const trade = (exit: number, high: number, low: number, over: Partial<HistoricalTrade> = {}): HistoricalTrade =>
  ({
    id: `t-${Math.random()}`, symbol: "SOL/INR", direction: "LONG", setupName: "Marcus Swing Trend", entryPrice: 100, exitPrice: exit,
    quantity: 10, moneyPlaced: 1000, realizedPnl: (exit - 100) * 10, realizedPnlPercent: 0, isWin: exit > 100,
    exitReason: exit > 100 ? "TRAILING_STOP" : "STOP_LOSS", openedAt: "", closedAt: "", riskAtOpen: 20, highestPrice: high, lowestPrice: low,
    ...over,
  }) as HistoricalTrade;

describe("how far a trade went each way", () => {
  it("is measured in R, for longs and shorts", () => {
    expect(tradeExcursion(trade(103, 104, 99))).toEqual({ bestR: 2, worstR: 0.5 });
    // A short from 100: the low is its best, the high its worst.
    expect(tradeExcursion(trade(98, 101, 97, { direction: "SHORT" }))).toEqual({ bestR: 1.5, worstR: 0.5 });
    // Trades closed before this was recorded have no answer.
    expect(tradeExcursion(trade(103, 104, 99, { highestPrice: undefined }))).toBeNull();
    expect(tradeExcursion(trade(103, 104, 99, { riskAtOpen: undefined }))).toBeNull();
  });

  it("sums up to the winners' worst dip, the losers' best point and how much of the best move winners kept", () => {
    // Ten winners, each dipping a little further (0.1R to 1.0R), each closing at +1R after reaching +2R.
    const winners = Array.from({ length: 10 }, (_, k) => trade(102, 104, 100 - 0.2 * (k + 1)));
    // Four losers: two got to +0.5R or more first.
    const losers = [trade(98, 101.6, 98), trade(98, 101, 98), trade(98, 100.4, 98), trade(98, 100, 98)];
    const x = excursionSummary([...winners, ...losers]);
    expect(x.ready).toBe(true);
    expect(x.winnersWorstR).toBeCloseTo(0.9, 6); // 9 in 10 dipped no more than 0.9R
    expect(x.losersBestR).toBeCloseTo((0.8 + 0.5 + 0.2 + 0) / 4, 6);
    expect(x.losersHalfR).toBe(2);
    expect(x.keptShare).toBeCloseTo(0.5, 6); // +1R kept of +2R
  });

  it("shows the card once enough trades have recorded it", () => {
    const few = Array.from({ length: MIN_EXCURSION_TRADES - 1 }, () => trade(102, 104, 99));
    const { rerender } = render(createElement(HowTradesMoved, { trades: few }));
    expect(screen.getByText(/9 closed trades have recorded how far they went each way; this shows once 10 have/)).toBeTruthy();
    rerender(createElement(HowTradesMoved, { trades: [...few, trade(98, 101.6, 98)] }));
    expect(screen.getByText("Winners' worst dip")).toBeTruthy();
    expect(screen.getByText(/9 in 10 winners went no more than 0.50R against you/)).toBeTruthy();
    expect(screen.getByText(/1 of 1 got to \+0.5R/)).toBeTruthy();
    // Older trades without the record don't count or show anything.
    rerender(createElement(HowTradesMoved, { trades: [trade(102, 104, 99, { lowestPrice: undefined })] }));
    expect(screen.queryByLabelText("How trades moved")).toBeNull();
  });
});
