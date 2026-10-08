// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FailureInjectionState, Position, RiskCalculation } from "../../src/types";

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { LedgerRisk } = await import("../../src/components/ledger/LedgerRisk");
const { allStops } = await import("../../src/components/ledger/RiskGlance");
const { HOLD_MS } = await import("../../src/components/ledger/ui");

// Book → Risk at a glance: the loss limit left, what every open stop would take, the money in trades, and a held stop.

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const pos = (symbol: string, qty: number, entry: number, stop: number): Position => ({
  id: symbol, symbol, direction: "LONG", setupName: "Breakout 55/20", strategy: "breakout", entryPrice: entry, currentPrice: entry,
  quantity: qty, stopLoss: stop, initialStopLoss: stop, takeProfit: 0, unrealizedPnl: 0, unrealizedPnlPercent: 0,
  openTime: new Date().toISOString(), expectedHoldingTimeMinutes: 525600, metaConfidence: 0.6,
});
// The desk's three open US trades on 7 Oct.
const open = [pos("NVDA.US", 4.3339, 23073, 22034), pos("MSFT.US", 1.9675, 50824, 48738), pos("QQQ.US", 1.3732, 72812, 71029)];

// ₹10 lakh of paper money: a ₹25,000 daily loss limit, ₹500 lost today, 30% in trades.
const riskCalc: RiskCalculation = {
  equity: 1000000, maxRiskPerTradeFraction: 0.01, hardDailyLossLimit: 25000, currentDailyLoss: 500,
  portfolioExposureFraction: 0.3, maxAllowedExposureFraction: 0.5, openPositionCount: 3, maxSimultaneousPositions: 6,
  fractionalKellyFraction: 0.25, recommendedPositionSizeUnits: 0, recommendedDollarExposure: 0, riskDollars: 0, passedAllChecks: true,
};
const noDrills: FailureInjectionState = {
  globalKillSwitchActive: false, simulateAgentTimeout: false, simulateStaleMarketData: false,
  simulateDailyLossBreach: false, simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false,
};
const props = (over: Record<string, unknown> = {}) => ({
  riskCalc, failureState: noDrills, onUpdateFailureState: vi.fn(), onResetFailures: vi.fn(), stopped: false,
  onToggleStop: vi.fn(), coinDcxStatus: null, positions: open, ...over,
});

describe("risk at a glance", () => {
  it("adds up what every open stop would take, and its share of the day's limit", () => {
    // NVDA ₹1,039 × 4.3339, MSFT ₹2,086 × 1.9675, QQQ ₹1,783 × 1.3732: −₹11,056 together, 44% of ₹25,000.
    const s = allStops(open, 25000);
    expect(s.net).toBeCloseTo(-11055.5, 0);
    expect(s.share).toBeCloseTo(44.2, 1);
    // A stop above the entry locks a gain in, which offsets the others.
    expect(allStops([...open, pos("GLD.US", 4, 21000, 21500)], 25000).net).toBeCloseTo(-9055.5, 0);
    expect(allStops(open, 0).share).toBe(0);
  });

  it("draws the three rings and says what each is", () => {
    render(createElement(LedgerRisk, props()));
    expect(screen.getByTestId("ring-loss-left").style.getPropertyValue("--nx-ring")).toBe("98.0");
    expect(screen.getByTestId("ring-all-stops").style.getPropertyValue("--nx-ring")).toBe("44.2");
    expect(screen.getByTestId("ring-in-trades").style.getPropertyValue("--nx-ring")).toBe("30.0");
    expect(screen.getByTestId("glance-loss-left").textContent).toBe("₹24,500 of today's ₹25,000 loss limit left");
    expect(screen.getByTestId("glance-all-stops").textContent).toBe("44% of the limit if every stop hit");
    expect(screen.getByTestId("glance-in-trades").textContent).toBe("30% of the money in trades");
  });

  it("lists each open trade's loss at its stop, the biggest first, and the total", () => {
    render(createElement(LedgerRisk, props({ positions: [...open, pos("GLD.US", 4, 21000, 21500)] })));
    expect(screen.getByTestId("stops-total").textContent).toBe("−₹9,056");
    expect(screen.getAllByTestId("stop-row").map((r) => r.textContent)).toEqual([
      "NVDA.US stop 22,034−₹4,503",
      "MSFT.US stop 48,738−₹4,104",
      "QQQ.US stop 71,029−₹2,448",
      "GLD.US stop 21,500+₹2,000 locked in",
    ]);
    const bars = screen.getAllByTestId("stop-row").map((r) => (r.querySelector(".bg-loss\\/75") as HTMLElement | null)?.style.width ?? null);
    expect(bars).toEqual(["100%", `${((4104.21 / 4502.92) * 100).toFixed(1)}%`, `${((2448.42 / 4502.92) * 100).toFixed(1)}%`, null]);
    expect(screen.getByLabelText("If every stop hit now").textContent).toContain("this is the most today could cost from what's open, 36% of today's loss limit.");
  });

  it("leaves out what stops would take with nothing open", () => {
    render(createElement(LedgerRisk, props({ positions: [] })));
    expect(screen.queryByTestId("ring-all-stops")).toBeNull();
    expect(screen.queryByTestId("glance-all-stops")).toBeNull();
    expect(screen.queryByLabelText("If every stop hit now")).toBeNull();
  });

  it("stops all trading only when held, and resumes on a tap", () => {
    vi.useFakeTimers();
    const p = props();
    const { rerender } = render(createElement(LedgerRisk, p));
    const hold = screen.getByRole("button", { name: "Hold to stop all trading" });
    // A short press doesn't stop it.
    fireEvent.pointerDown(hold);
    act(() => vi.advanceTimersByTime(HOLD_MS / 2));
    fireEvent.pointerUp(hold);
    expect(p.onToggleStop).not.toHaveBeenCalled();
    fireEvent.pointerDown(hold);
    act(() => vi.advanceTimersByTime(HOLD_MS + 10));
    expect(p.onToggleStop).toHaveBeenCalledTimes(1);

    rerender(createElement(LedgerRisk, { ...p, stopped: true }));
    expect(screen.getByLabelText("Trading stopped").textContent).toContain("No new trades. Open ones stay guarded.");
    expect(screen.queryByRole("button", { name: "Hold to stop all trading" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(p.onToggleStop).toHaveBeenCalledTimes(2);
  });
});
