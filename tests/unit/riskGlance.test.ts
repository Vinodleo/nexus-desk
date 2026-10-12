// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FailureInjectionState, Position, RiskCalculation } from "../../src/types";
import { cleanMarketLimits } from "../../src/shared/marketLimits";

vi.mock("../../src/services/apiClient", () => ({ apiFetch: vi.fn(), authenticateSocket: vi.fn() }));
const { LedgerRisk } = await import("../../src/components/ledger/LedgerRisk");
const { allStops } = await import("../../src/components/ledger/RiskGlance");
const { HOLD_MS } = await import("../../src/components/ledger/ui");

// Book → Risk at a glance: the loss limit left, what every open stop would take, the money in trades, the slots, and a held stop.

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

  it("draws the three rings side by side and says what each is", () => {
    render(createElement(LedgerRisk, props()));
    const ring = (id: string) => screen.getByTestId(id);
    expect(ring("ring-loss-left").getAttribute("data-pct")).toBe("98.0");
    expect(ring("ring-all-stops").getAttribute("data-pct")).toBe("44.2");
    expect(ring("ring-in-trades").getAttribute("data-pct")).toBe("30.0");
    // Each sweeps round from empty: its dash offset is the part of the circle not filled.
    const c = 2 * Math.PI * 36;
    expect(ring("ring-in-trades").style.strokeDashoffset).toBe((c * 0.7).toFixed(1));
    expect(ring("ring-in-trades").style.getPropertyValue("--nx-c")).toBe(c.toFixed(1));
    expect(screen.getByTestId("ring-loss-left-cell").textContent).toBe("98%Loss limit left₹24,500 of ₹25,000");
    expect(screen.getByTestId("ring-all-stops-cell").textContent).toBe("44%If every stop hit−₹11,056");
    expect(screen.getByTestId("ring-in-trades-cell").textContent).toBe("30%Money in trades₹3,00,000");
  });

  it("lists each open trade's loss at its stop, the biggest first, and the total", () => {
    render(createElement(LedgerRisk, props({ positions: [...open, pos("GLD.US", 4, 21000, 21500)] })));
    expect(screen.getByTestId("stops-total").textContent).toBe("−₹9,056");
    expect(screen.getAllByTestId("stop-row").map((r) => r.textContent)).toEqual(["NVDA−₹4,503", "MSFT−₹4,104", "QQQ−₹2,448", "GLD+₹2,000locked in"]);
    expect(screen.getAllByTestId("stop-row")[0].getAttribute("title")).toBe("Stop 22,034");
    const bars = screen.getAllByTestId("stop-row").map((r) => (r.querySelector(".bg-loss\\/75") as HTMLElement | null)?.style.width ?? null);
    expect(bars).toEqual(["100%", `${((4104.21 / 4502.92) * 100).toFixed(1)}%`, `${((2448.42 / 4502.92) * 100).toFixed(1)}%`, null]);
    expect(screen.getByTestId("stops-note").textContent).toBe(
      "Each open trade at its stop, before fees: 36% of today's loss limit. Stops seldom all hit on one day."
    );
  });

  it("says nothing is open, and lists no stops, with nothing open", () => {
    render(createElement(LedgerRisk, props({ positions: [] })));
    expect(screen.getByTestId("ring-all-stops").getAttribute("data-pct")).toBe("0.0");
    expect(screen.getByTestId("ring-all-stops-cell").textContent).toBe("0%If every stop hitNothing open");
    expect(screen.queryByLabelText("If every stop hit now")).toBeNull();
  });

  it("shows each slower strategy's slots in use, calm when full", () => {
    const limits = cleanMarketLimits(null);
    const more = [pos("GLD.US", 4, 21000, 21500), pos("AAPL.US", 3, 21000, 20100), { ...pos("META.US", 1, 600, 560), strategy: "momentum" as const }];
    render(createElement(LedgerRisk, props({ marketLimits: limits, positions: [...open, ...more] })));
    // NVDA, MSFT and AAPL fill US breakout's three; QQQ and GLD are funds; META is momentum.
    const meter = (name: string) => screen.getByRole("meter", { name });
    expect(meter("US breakout slots").getAttribute("aria-valuenow")).toBe("100");
    expect(meter("US breakout slots").className).not.toMatch(/nx-pulse/);
    expect(meter("US breakout slots").querySelector(".bg-accent")).not.toBeNull();
    expect(meter("Funds breakout slots").getAttribute("aria-valuenow")).toBe("67");
    expect(meter("US momentum slots").getAttribute("aria-valuenow")).toBe("33");
    expect(meter("Coin breakout slots").getAttribute("aria-valuenow")).toBe("0");
    expect(screen.getByLabelText("Limits").textContent).toContain("US breakout slots3 of 3");
  });

  it("stops all trading only when held, unfolds a note that stops are still watched, and resumes on a tap", () => {
    vi.useFakeTimers();
    const p = props();
    const { rerender } = render(createElement(LedgerRisk, p));
    // Folded away while trading.
    expect(screen.queryByRole("status", { name: "Trading stopped" })).toBeNull();
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
    const note = screen.getByRole("status", { name: "Trading stopped" });
    expect(note.textContent).toBe("Trading stopped. No new trades open. The guardian still watches every stop on the server.");
    expect(note.closest(".nx-fold")!.className).toContain("nx-fold-open");
    expect(screen.queryByRole("button", { name: "Hold to stop all trading" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume trading" }));
    expect(p.onToggleStop).toHaveBeenCalledTimes(2);
  });
});
