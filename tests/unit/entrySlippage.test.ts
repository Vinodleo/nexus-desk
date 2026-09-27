// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { entrySlip } from "../../src/components/ledger/format";
import { LedgerBreakdown, breakdown } from "../../src/components/ledger/LedgerBreakdown";
import type { HistoricalTrade } from "../../src/types";

// What an entry cost next to the signal: the price paid against the price
// the signal came from (its candle's close), per market.

afterEach(cleanup);

const trade = (over: Partial<HistoricalTrade> = {}): HistoricalTrade =>
  ({
    id: `t-${Math.random()}`, symbol: "SOL/INR", direction: "LONG", setupName: "Marcus Swing Trend", entryPrice: 1001, exitPrice: 1010,
    quantity: 1, moneyPlaced: 1001, realizedPnl: 8, realizedPnlPercent: 0.8, isWin: true, exitReason: "TRAILING_STOP",
    openedAt: "", closedAt: "", closedAtMs: Date.now(), signalPrice: 1000, ...over,
  }) as HistoricalTrade;

describe("what an entry cost", () => {
  it("is the % paid past the signal's price: positive worse, negative better", () => {
    expect(entrySlip(trade())!.pct).toBeCloseTo(0.1, 6); // bought at 1001 on a 1000 signal
    expect(entrySlip(trade({ entryPrice: 999 }))!.pct).toBeCloseTo(-0.1, 6);
    // A short sells: selling lower than the signal is worse.
    expect(entrySlip(trade({ direction: "SHORT", entryPrice: 999 }))!.pct).toBeCloseTo(0.1, 6);
    // Trades from before it was recorded.
    expect(entrySlip(trade({ signalPrice: undefined }))).toBeNull();
  });

  it("is averaged per group, over the trades that recorded it", () => {
    const [row] = breakdown([trade(), trade({ entryPrice: 1003 }), trade({ signalPrice: undefined })], () => "all");
    expect(row.avgEntrySlipPct).toBeCloseTo(0.2, 6);
  });

  it("shows on the Book's breakdown, with each market on its own row", () => {
    render(createElement(LedgerBreakdown, { trades: [trade(), trade({ symbol: "SBIN", entryPrice: 999 })] }));
    const byMarket = screen.getByLabelText("By market");
    expect(byMarket.textContent).toContain("Coins");
    expect(byMarket.textContent).toContain("entries paid 0.10% more than the signal on average");
    expect(byMarket.textContent).toContain("Indian stocks");
    expect(byMarket.textContent).toContain("entries got 0.10% better than the signal on average");
  });
});
