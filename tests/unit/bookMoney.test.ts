// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoricalTrade } from "../../src/types";

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { apiFetch } = await import("../../src/services/apiClient");
const { LedgerBreakdown, tradesIn } = await import("../../src/components/ledger/LedgerBreakdown");
const { exitWords, moneyFlow, strategyBadge, strategyOf } = await import("../../src/components/ledger/BookMoney");

// Book → Breakdown: where the money went, each strategy's result, and the win rate against break-even.

afterEach(cleanup);
beforeEach(() => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: false } as Response);
});

const NOW = new Date(2026, 9, 8, 12).getTime(); // Thursday 8 Oct 2026, noon on this machine
const DAY = 86400000;
function trade(id: string, symbol: string, pnl: number, fees: number, daysAgo: number, over: Partial<HistoricalTrade> = {}): HistoricalTrade {
  return {
    id, symbol, direction: "LONG", setupName: "Breakout 55/20", entryPrice: 100, exitPrice: 101, quantity: 1, moneyPlaced: 100000,
    feesPaid: fees, realizedPnl: pnl, realizedPnlPercent: 0, isWin: pnl > 0, exitReason: pnl > 0 ? "TRAILING_STOP" : "STOP_LOSS",
    openedAt: "", closedAt: "", closedAtMs: NOW - daysAgo * DAY, strategy: "breakout", ...over,
  };
}
// The design's sample: coin breakout trades pay CoinDCX's fee both ways; US ones a little.
const trades = [
  trade("a", "AAPL.US", -4210, 38, 2),
  trade("b", "GLD.US", 6880, 40, 2),
  trade("c", "SOL/INR", -2950, 1169, 3),
  trade("d", "AVGO.US", 2140, 40, 5, { strategy: "momentum" }),
  trade("e", "BTC/INR", 9420, 1243, 6),
  trade("f", "ETH/INR", 900, 1186, 8),
  trade("g", "META.US", -1575, 38, 8),
  trade("h", "TLT.US", -2310, 36, 9),
];

describe("where the money went", () => {
  it("splits what winners made and losers lost before fees, the fees, and what was kept", () => {
    const f = moneyFlow(trades);
    // Before fees: winners +₹21,849 (GLD, AVGO, BTC, ETH), losers −₹9,764; fees ₹3,790, ₹3,598 of them on coins.
    expect(f).toEqual({ won: 21849, lost: 9764, fees: 3790, kept: 8295, coinFees: 3598 });
    expect(f.kept).toBe(trades.reduce((s, t) => s + t.realizedPnl, 0));
  });

  it("names each trade's strategy", () => {
    expect(trades.map(strategyOf)).toEqual([
      "US breakout", "Funds breakout", "Coin breakout", "US momentum", "Coin breakout", "Coin breakout", "US breakout", "Funds breakout",
    ]);
    expect(strategyOf(trade("x", "SOL/INR", 1, 0, 0, { strategy: undefined, timeframe: "1d" }))).toBe("Daily traders");
    expect(strategyOf(trade("y", "SOL/INR", 1, 0, 0, { strategy: undefined }))).toBe("5-minute traders");
    expect(trades.map(strategyBadge)).toEqual(["BO", "FD", "CB", "T3", "CB", "CB", "BO", "FD"]);
  });

  it("says how a trade ended: the slower strategies' own sales by their rule", () => {
    // Breakout sells below its 20-day low and momentum when out of the top 3; both are recorded as trailing-stop exits.
    expect(exitWords(trade("x", "NVDA.US", 1, 0, 0, { exitReason: "TRAILING_STOP" }))).toBe("Below its 20-day low");
    expect(exitWords(trade("x", "NVDA.US", 1, 0, 0, { strategy: "momentum", exitReason: "TRAILING_STOP" }))).toBe("Left the top 3");
    expect(exitWords(trade("x", "NVDA.US", -1, 0, 0))).toBe("Stop loss");
    expect(exitWords(trade("x", "SOL/INR", 1, 0, 0, { strategy: undefined, exitReason: "TRAILING_STOP" }))).toBe("Trailing stop");
  });

  it("takes the last 7 days, this month, or all", () => {
    expect(tradesIn(trades, "week", NOW).map((t) => t.id)).toEqual(["a", "b", "c", "d", "e"]);
    // October from the 1st: 2 Oct (6 days ago) is in, 30 Sep (8 days ago) is not.
    expect(tradesIn(trades, "month", NOW).map((t) => t.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(tradesIn(trades, "month", new Date(2026, 9, 4, 12).getTime()).map((t) => t.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(tradesIn(trades, "all", NOW)).toHaveLength(8);
  });

  it("draws the waterfall and says it in words, with what coin fees took", () => {
    render(createElement(LedgerBreakdown, { trades, now: NOW }));
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByTestId("wf-kept-total").textContent).toBe("+₹8,295");
    expect(screen.getByLabelText("Where the money went").textContent).toContain(
      "+₹21,849Won before fees−₹9,764Lost before fees−₹3,790Fees+₹8,295Kept"
    );
    expect(screen.getByTestId("waterfall-words").textContent).toBe(
      "Fees took ₹3,790, 17% of what the winners made before fees. Coin trades paid ₹3,598 of them: CoinDCX takes 0.59% each way."
    );
    // Won reaches the top (4% to 88%); Lost steps down from it; Kept stands from zero.
    const col = (k: string) => screen.getByTestId(`wf-${k}`).style;
    expect(col("won").bottom).toBe("4%");
    expect(col("won").height).toBe("84%");
    expect(col("lost").bottom).toBe(`${((21849 - 9764) / 21849 * 84 + 4).toFixed(2)}%`);
    expect(screen.getByTestId("wf-lost").className).toContain("nx-drop");
    expect(screen.getByTestId("wf-kept").className).toContain("bg-accent");
  });

  it("ranks each strategy's result either side of zero, and puts the win rate on the gauge", () => {
    render(createElement(LedgerBreakdown, { trades, now: NOW }));
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    const rows = screen.getAllByTestId("strategy-row");
    expect(rows.map((r) => r.textContent)).toEqual([
      "Coin breakout · 3 trades+₹7,370",
      "Funds breakout · 2 trades+₹4,570",
      "US momentum · 1 trade+₹2,140",
      "US breakout · 2 trades−₹5,785",
    ]);
    // Half the track either side of the middle: the best fills the right half, US breakout reaches left from it.
    const bars = screen.getAllByTestId("strategy-bar").map((b) => (b as HTMLElement).style);
    expect([bars[0].left, bars[0].width]).toEqual(["50%", "50%"]);
    const w = (5785 / 7370) * 50;
    expect([bars[3].left, bars[3].width]).toEqual([`${(50 - w).toFixed(2)}%`, `${w.toFixed(2)}%`]);
    expect(screen.getAllByTestId("strategy-bar")[3].className).toContain("bg-loss");
    // 4 of 8 won; break-even from the average win and loss in rupees.
    const meter = screen.getByRole("meter", { name: "Win rate against break-even" });
    expect(meter.getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByTestId("gauge-needle").style.transform).toBe("rotate(0.0deg)");
    expect(screen.getByTestId("win-rate").textContent).toBe("50% won");
    // Break-even from the average win (₹4,835) and loss (₹2,761): 36%, the mark left of the top.
    expect(screen.getByTestId("gauge-break-even").style.transform).toBe("rotate(-25.2deg)");
    expect(screen.getByTestId("gauge-arc").style.strokeDasharray).toBe(`${(0.5 * Math.PI * 90).toFixed(1)} 400`);
    // A shorter period, the needle swings: the last 7 days won 3 of 5 (60%).
    fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
    expect(screen.getByTestId("gauge-needle").style.transform).toBe("rotate(18.0deg)");
  });

  it("shows nothing for a period without trades", () => {
    render(createElement(LedgerBreakdown, { trades: [trade("old", "BTC/INR", 100, 10, 40)], now: NOW }));
    expect(screen.queryByTestId("waterfall")).toBeNull();
    expect(screen.queryByLabelText("By strategy")).toBeNull();
  });
});
