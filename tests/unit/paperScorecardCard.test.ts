// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoricalTrade, Position } from "../../src/types";

// The Lab's "Paper trades against the replay" card.

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { apiFetch } = await import("../../src/services/apiClient");
const { PaperScorecard } = await import("../../src/components/ledger/PaperScorecard");

afterEach(cleanup);

const routes: Record<string, unknown> = {
  "/api/daily-coins": {
    success: true,
    run: null,
    traders: [
      // Sofia trades (+0.22R over 145, 41% won); Kenji is paused, so not part of what the daily traders expect.
      { trader: "Sofia Range Scalp", trades: 145, avgR: 0.22, on: true, wins: 60, winR: 100, lossR: -68.1 },
      { trader: "Kenji Extreme Reversion", trades: 8, avgR: 0.28, on: false, wins: 4, winR: 4, lossR: -1.76 },
    ],
    // +0.98R over 476: 25% won, wins +5.00R, losses −0.36R.
    breakout: { trader: "Breakout 55/20", trades: 476, avgR: 0.98, on: true, wins: 119, winR: 595, lossR: -128.52 },
    nextAt: 0,
  },
  "/api/us-breakout": { success: true, run: null, gate: { trader: "Breakout 55/20", trades: 554, avgR: 0.39, on: true, wins: 205, winR: 600, lossR: -383.94 }, slots: null, nextAt: 0 },
  // +0.26R over 341: 53% won.
  "/api/us-momentum": { success: true, run: null, gate: { trader: "Momentum, top 3", trades: 341, avgR: 0.26, on: true, wins: 181, winR: 300, lossR: -211.34 }, slots: null, nextAt: 0 },
};
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (path: string) => new Response(JSON.stringify(routes[path] ?? null), { status: routes[path] ? 200 : 404 }));
});

const trade = (r: number, over: Partial<HistoricalTrade> = {}): HistoricalTrade => ({
  id: `t${r}`, symbol: "SOL/INR", direction: "LONG", setupName: "Breakout 55/20", entryPrice: 100, exitPrice: 100, quantity: 1, moneyPlaced: 100,
  realizedPnl: r * 10, realizedPnlPercent: 0, riskAtOpen: 10, isWin: r > 0, exitReason: "TRAILING_STOP", openedAt: "", closedAt: "", strategy: "breakout", timeframe: "1d",
  ...over,
});

describe("Paper trades against the replay", () => {
  it("sets each slower strategy's paper trades against its replay, and says when it's too early to tell", async () => {
    const trades = [trade(3), trade(-1, { exitReason: "STOP_LOSS", stopAtExit: 95, fillAtExit: 93 })];
    const positions = [{ symbol: "XRP/INR", strategy: "breakout" }, { symbol: "ETH/INR", timeframe: "1d" }] as Position[];
    render(createElement(PaperScorecard, { trades, positions }));
    const coins = await screen.findByTestId("score-coinBreakout");
    expect(coins.textContent).toContain("Coin breakout 55/20–Too early · 2 of 10");
    expect(screen.getByTestId("score-coinBreakout-bars").textContent).toBe("Paper2 closed+1.00R" + "Replay476 trades+0.98R");
    expect(coins.textContent).toContain("1 open · 50% won (replay 25%) · P&L +₹20");
    expect(coins.textContent).toContain("Average win +3.00R (replay +5.00R) · average loss −1.00R (replay −0.36R)");
    expect(coins.textContent).toContain("Exits: 1 sold below the 20-day low · 1 at the stop (1 gapped past it).");
    // None closed yet: what the replay expects.
    expect(screen.getByTestId("score-usBreakout").textContent).toBe("US breakout 55/20–Too earlyNo paper trades yet. The replay expects +0.39R a trade, 37% won.");
    expect(screen.getByTestId("score-dailyCoins").textContent).toBe("Daily coin traders–Too early1 open, none closed yet. The replay expects +0.22R a trade, 41% won.");
    // US momentum's trades: sold at the weekly check, or at the stop.
    expect(screen.getByTestId("score-usMomentum").textContent).toBe("US momentum, top 3–Too earlyNo paper trades yet. The replay expects +0.26R a trade, 53% won.");
    cleanup();
    render(createElement(PaperScorecard, { trades: [trade(2, { id: "mo1", symbol: "NVDA.US", strategy: "momentum" })], positions: [{ symbol: "AAPL.US", strategy: "momentum" }] as Position[] }));
    const momentum = await screen.findByTestId("score-usMomentum");
    expect(momentum.textContent).toContain("1 open · 100% won (replay 53%)");
    expect(momentum.textContent).toContain("Exits: 1 sold at the weekly check.");
  });

  it("calls 10+ trades in line with the replay, behind it or ahead of it", async () => {
    const mixed = Array.from({ length: 10 }, (_, i) => trade(i % 2 === 0 ? 2 : -1, { id: `m${i}` }));
    render(createElement(PaperScorecard, { trades: mixed, positions: [] }));
    const coins = await screen.findByTestId("score-coinBreakout");
    expect(coins.textContent).toContain("✓In line");
    expect(coins.textContent).toContain("Under 30 trades, luck still decides most of it.");
    cleanup();

    const losing = Array.from({ length: 10 }, (_, i) => trade(-1, { id: `l${i}`, exitReason: "STOP_LOSS", symbol: "AAPL.US", realizedPnl: i === 0 ? 5 : -10 }));
    render(createElement(PaperScorecard, { trades: losing, positions: [] }));
    expect((await screen.findByTestId("score-usBreakout")).textContent).toContain("✕Behind the replay");
  });
});
