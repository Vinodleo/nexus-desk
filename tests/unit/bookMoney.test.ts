// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoricalTrade } from "../../src/types";

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { apiFetch } = await import("../../src/services/apiClient");
const { LedgerBreakdown, tradesIn } = await import("../../src/components/ledger/LedgerBreakdown");
const { moneyFlow, strategyOf } = await import("../../src/components/ledger/BookMoney");

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
    expect(screen.getByTestId("waterfall-words").textContent).toBe(
      "Winners made ₹21,849 before fees, losers lost ₹9,764, fees took ₹3,790 (17% of what the winners made): kept ₹8,295." +
        " Coin trades paid ₹3,598 of the fees: CoinDCX takes 0.59% each way."
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
    expect((rows[0].querySelector(".bg-gain") as HTMLElement).style.width).toBe("100%");
    expect((rows[3].querySelector(".bg-loss\\/75") as HTMLElement).style.width).toBe(`${((5785 / 7370) * 100).toFixed(2)}%`);
    // 4 of 8 won; break-even from the average win and loss in rupees.
    const meter = screen.getByRole("meter", { name: "Win rate against break-even" });
    expect(meter.getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByTestId("gauge-needle").style.transform).toBe("rotate(0.0deg)");
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
