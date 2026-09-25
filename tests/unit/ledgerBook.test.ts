// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));

const { LedgerBook, dayLabel, summarizeTrades } = await import("../../src/components/ledger/LedgerBook");
const { LedgerRisk } = await import("../../src/components/ledger/LedgerRisk");
const { apiFetch } = await import("../../src/services/apiClient");
import type { FailureInjectionState, HistoricalTrade, RiskCalculation } from "../../src/types";

afterEach(cleanup);

const NOW = Date.now();
function trade(id: string, pnl: number, closedAtMs: number | undefined, over: Partial<HistoricalTrade> = {}): HistoricalTrade {
  return {
    id, symbol: "ETH/INR", direction: "LONG", setupName: "Breakout", entryPrice: 265000, exitPrice: 266000, quantity: 0.035,
    moneyPlaced: 9275, feesPaid: 9.3, realizedPnl: pnl, realizedPnlPercent: pnl / 92.75, isWin: pnl > 0,
    exitReason: pnl > 0 ? "TAKE_PROFIT" : "STOP_LOSS", openedAt: "", closedAt: "16:22", closedAtMs,
    openedAtMs: closedAtMs ? closedAtMs - 42 * 60000 : undefined, ...over,
  };
}

describe("book helpers", () => {
  it("sums wins, losses and fees by net P&L", () => {
    const s = summarizeTrades([trade("a", 142.1, NOW), trade("b", -88.4, NOW), trade("c", 31.2, NOW)]);
    expect(s.count).toBe(3);
    expect(s.won).toBeCloseTo(173.3);
    expect(s.lost).toBeCloseTo(88.4);
    expect(s.net).toBeCloseTo(84.9);
    expect(s.fees).toBeCloseTo(27.9);
    expect(s.winPct).toBe(67);
    expect(summarizeTrades([]).winPct).toBeNull();
  });

  it("labels days", () => {
    expect(dayLabel(NOW, NOW)).toBe("Today");
    expect(dayLabel(NOW - 86400000, NOW)).toBe("Yesterday");
    expect(dayLabel(undefined, NOW)).toBe("Earlier");
  });
});

describe("LedgerBook", () => {
  const trades = [trade("old", -210.55, NOW - 86400000), trade("win", 142.1, NOW), trade("loss", -88.4, NOW - 1000)];

  it("groups closed trades by day, newest first, and filters them", () => {
    const { container } = render(createElement(LedgerBook, { trades, risk: null }));
    const text = container.textContent ?? "";
    expect(text.indexOf("Today")).toBeLessThan(text.indexOf("Yesterday"));
    expect(text).toContain("3 trades");
    fireEvent.click(screen.getByRole("button", { name: "Wins" }));
    expect(container.textContent).toContain("+₹142.10");
    expect(container.textContent).not.toContain("−₹88.40");
    fireEvent.click(screen.getByRole("button", { name: "Losses" }));
    expect(container.textContent).not.toContain("+₹142.10");
  });

  it("expands a trade to show its details", () => {
    const { container } = render(createElement(LedgerBook, { trades: [trade("win", 142.1, NOW)], risk: null }));
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(container.textContent).toContain("Held for42 min");
    expect(container.textContent).toContain("Explain this trade");
  });

  it("switches to the Risk section", () => {
    render(createElement(LedgerBook, { trades: [], risk: createElement("p", null, "risk here"), riskBlocked: true }));
    expect(screen.getByText(/No closed trades yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Risk/ }));
    expect(screen.getByText("risk here")).toBeTruthy();
  });
});

describe("LedgerRisk", () => {
  const riskCalc: RiskCalculation = {
    equity: 94483.96, maxRiskPerTradeFraction: 0.01, hardDailyLossLimit: 2500, currentDailyLoss: 500,
    portfolioExposureFraction: 0.099, maxAllowedExposureFraction: 0.5, openPositionCount: 2, maxSimultaneousPositions: 3,
    fractionalKellyFraction: 0.25, recommendedPositionSizeUnits: 0, recommendedDollarExposure: 0, riskDollars: 0,
    passedAllChecks: true,
  };
  const noDrills: FailureInjectionState = {
    globalKillSwitchActive: false, simulateAgentTimeout: false, simulateStaleMarketData: false,
    simulateDailyLossBreach: false, simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false,
  };
  const base = {
    riskCalc, failureState: noDrills, onUpdateFailureState: vi.fn(), onResetFailures: vi.fn(), stopped: false,
    onToggleStop: vi.fn(), coinDcxStatus: null,
  };

  it("shows limits as meters", () => {
    const { container } = render(createElement(LedgerRisk, base));
    expect(container.textContent).toContain("All checks passing.");
    expect(screen.getByRole("meter", { name: "Daily loss" }).getAttribute("aria-valuenow")).toBe("20");
    expect(container.textContent).toContain("2 of 3");
  });

  it("reports trades as blocked while a drill is on, and turns drills on and off", () => {
    const p = { ...base, onUpdateFailureState: vi.fn(), onResetFailures: vi.fn() };
    const { container, rerender } = render(createElement(LedgerRisk, p));
    fireEvent.click(screen.getByRole("switch", { name: "Stale market data" }));
    expect(p.onUpdateFailureState).toHaveBeenCalledWith("simulateStaleMarketData", true);

    rerender(createElement(LedgerRisk, { ...p, failureState: { ...noDrills, simulateStaleMarketData: true } }));
    expect(container.textContent).toContain("New trades blocked. A safety drill is on.");
    fireEvent.click(screen.getByRole("button", { name: "Turn off all drills" }));
    expect(p.onResetFailures).toHaveBeenCalled();
  });

  it("checks the CoinDCX keys with the server", async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: "Bad key" })));
    const status = { configured: true, keyMasked: "ab…cd", liveRisk: { enabled: false } } as any;
    render(createElement(LedgerRisk, { ...base, coinDcxStatus: status }));
    fireEvent.click(screen.getByRole("button", { name: "Check CoinDCX keys" }));
    expect(await screen.findByText("Bad key")).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledWith("/api/coindcx/validate-keys", { method: "POST" });
  });
});

describe("the Book's breakdown tab", () => {
  it("explains wins against losses, and shows which traders the scanner lets trade", async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          table: {
            profile: "tight",
            measuredAt: NOW,
            symbols: 40,
            minMarketTrades: 30,
            rows: [
              { market: "crypto", trader: "Priya Momentum Scalp", trades: 30, winPct: 60, avgWinR: 0.4, avgLossR: -0.3, avgR: 0.12, judgedR: 0.09 },
              { market: "crypto", trader: "Chen Conservative Trend", trades: 20, winPct: 40, avgWinR: 0.3, avgLossR: -0.9, avgR: -0.42, judgedR: -0.3 },
            ],
          },
          activity: {
            minActivity: 0.5,
            coins: [
              { symbol: "BTC/INR", activity: 0.98, spreadPct: 0.0059 },
              { symbol: "ZEC/INR", activity: 0.38, spreadPct: 0.004 },
            ],
          },
        })
      )
    );
    render(
      createElement(LedgerBook, {
        trades: [trade("a", 36, NOW, { riskAtOpen: 60 }), trade("b", 36, NOW, { riskAtOpen: 60 }), trade("c", -64, NOW, { setupName: "Chen", riskAtOpen: 60 })],
        risk: null,
      })
    );
    fireEvent.click(screen.getByRole("tab", { name: "Breakdown" }));
    expect(screen.getByText(/breaking even takes winning/).textContent).toMatch(/64%.*You won 67%/);
    expect(await screen.findByText("Traders with your exits")).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByText("Trading")).toBeTruthy();
    expect(screen.getByLabelText("By trader").textContent).toMatch(/Chen.*−₹64/);
    // Each coin's spread and activity; coins that trade too rarely are marked skipped.
    const costs = screen.getByLabelText("What coins cost to trade").textContent ?? "";
    expect(costs).toMatch(/BTC\/INRspread 0\.59% · trades in 98% of minutes/);
    expect(costs).toMatch(/ZEC\/INRspread 0\.40% · trades in 38% of minutes · skipped/);
    expect(costs.match(/skipped/g)).toHaveLength(1);
  });
});
