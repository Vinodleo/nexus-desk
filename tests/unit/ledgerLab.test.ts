// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  fetchRealHistoricalCandles: vi.fn(),
  runRealDataWalkForward: vi.fn(),
  runGlobalMarketTraining: vi.fn(),
  parseCSVToCandles: vi.fn(),
}));
vi.mock("../../src/services/realDataBacktestService", () => service);

const { LedgerLab, isResultPromoted } = await import("../../src/components/ledger/LedgerLab");
import type { PromotedLabModel } from "../../src/types";

afterEach(cleanup);

function result(over: Record<string, unknown> = {}) {
  return {
    symbol: "BTCINR", timeframe: "1h", candlesCount: 500, dateRange: { start: "2026-08-01", end: "2026-09-20" },
    baselineMetrics: { tradesCount: 40, winRate: 48, accuracyPercent: 50, sharpeRatio: 0.4, profitFactor: 1, maxDrawdownPercent: 8, netPnlDollars: 0 },
    learnedMetrics: { tradesCount: 28, winRate: 57, accuracyPercent: 58, sharpeRatio: 0.9, profitFactor: 1.4, maxDrawdownPercent: 5, netPnlDollars: 10, accuracyImprovementDelta: 8 },
    inSampleTrades: [], outOfSampleTrades: [],
    distilledLessons: [{ id: "l1", rule: "Skip breakouts on thin volume", regime: "ranging", action: "veto" }],
    folds: [1, 2, 3, 4, 5].map((fold) => ({ fold, trainRange: "", testRange: "", inSampleAccuracy: 60, outOfSampleAccuracy: 55, passed: fold !== 3 })),
    ...over,
  };
}

const promoted: PromotedLabModel = {
  promotedAt: "2026-09-20T10:00:00Z", datasetName: "ETH/INR (1h, 500 bars via Coinbase)", accuracyPct: 61, winRatePct: 58,
  sharpeRatio: 1, totalCandlesEvaluated: 500, distilledRulesCount: 2, distilledLessons: [],
};

describe("LedgerLab", () => {
  it("trains on one market and offers to promote the result", async () => {
    service.fetchRealHistoricalCandles.mockResolvedValue([{ isSynthetic: false, sourceExchange: "Coinbase Public API" }]);
    service.runRealDataWalkForward.mockResolvedValue(result());
    const onPromote = vi.fn();
    render(createElement(LedgerLab, { promotedLabModel: null, onPromote, onRevert: vi.fn() }));
    expect(screen.getByText(/No Lab model promoted/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Train on BTC/INR" }));
    expect(await screen.findByText("BTC/INR (5m, 1 bars via Coinbase Public API)")).toBeTruthy();
    expect(service.fetchRealHistoricalCandles).toHaveBeenCalledWith("BTCINR", "5m", 3000, "BINANCE");
    expect(screen.getByText("4 of 5 periods passed")).toBeTruthy();
    expect(screen.getByText("Skip breakouts on thin volume")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Promote to live" }));
    expect(onPromote).toHaveBeenCalled();
  });

  it("won't promote a result built on generated prices", async () => {
    service.fetchRealHistoricalCandles.mockResolvedValue([{ isSynthetic: true, sourceExchange: "Deterministic Fallback" }]);
    service.runRealDataWalkForward.mockResolvedValue(result());
    render(createElement(LedgerLab, { promotedLabModel: null, onPromote: vi.fn(), onRevert: vi.fn() }));
    fireEvent.click(screen.getByRole("button", { name: "Train on BTC/INR" }));
    expect(await screen.findByText(/ran on generated prices/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Promote to live" })).toBeNull();
  });

  it("won't promote a result with too few test trades", async () => {
    service.fetchRealHistoricalCandles.mockResolvedValue([{ isSynthetic: false, sourceExchange: "Binance Public API" }]);
    service.runRealDataWalkForward.mockResolvedValue(result({ learnedMetrics: { ...result().learnedMetrics, tradesCount: 2 } }));
    render(createElement(LedgerLab, { promotedLabModel: null, onPromote: vi.fn(), onRevert: vi.fn() }));
    fireEvent.click(screen.getByRole("button", { name: "Train on BTC/INR" }));
    expect(await screen.findByText(/Only 2 test trades/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Promote to live" })).toBeNull();
  });

  it("shows the model in use and reverts it after a confirm", () => {
    const onRevert = vi.fn();
    render(createElement(LedgerLab, { promotedLabModel: promoted, onPromote: vi.fn(), onRevert }));
    expect(screen.getByText(promoted.datasetName)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revert to built-in rules" }));
    expect(onRevert).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    expect(onRevert).toHaveBeenCalled();
  });

  it("knows when a result is the model already in use", () => {
    const r = result({ datasetName: promoted.datasetName, learnedMetrics: { ...result().learnedMetrics, accuracyPercent: 61 } });
    expect(isResultPromoted(r as any, promoted)).toBe(true);
    expect(isResultPromoted(result() as any, promoted)).toBe(false);
    expect(isResultPromoted(r as any, null)).toBe(false);
  });
});
