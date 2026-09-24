// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LedgerQueue, describeProposal, type LedgerQueueProps } from "../../src/components/ledger/LedgerQueue";
import type { TradeProposal } from "../../src/types";

afterEach(cleanup);

function proposal(id: string, symbol: string, pWin: number, over: Partial<TradeProposal> = {}): TradeProposal {
  return {
    id,
    timestamp: new Date(Date.now() - 3 * 60000).toISOString(),
    symbol,
    setup: {
      id: `s-${id}`, name: "Breakout", family: "trend_following", direction: "LONG", symbol, timeframe: "5m",
      entryPrice: 1000, stopLoss: 990, takeProfit: 1030, riskRewardRatio: 3, baseProbability: 0.5, qualifies: true,
      features: { emaAlignment: true, volumeSurgeRatio: 2, vwapDistancePercent: 0.1, adx: 30, rsi: 55, atr: 5 },
    },
    regime: "trending_bullish",
    metaScore: {
      setupId: `s-${id}`, confidence: pWin, calibratedWinProbability: pWin, historicalSampleCount: 40,
      historicalWinRate: pWin, confidenceRationale: "", regimeFit: "optimal",
    },
    evAssessment: {
      pWin, avgWinDollars: 900, pLoss: 1 - pWin, avgLossDollars: 300, estimatedSpreadCost: 0, estimatedBrokerageFee: 0,
      estimatedSlippageCost: 0, estimatedLatencyTax: 0, totalCost: 10, expectedNetValue: 126, isPositiveEdge: true,
    },
    riskCalc: {
      equity: 100000, maxRiskPerTradeFraction: 0.01, hardDailyLossLimit: 2500, currentDailyLoss: 0,
      portfolioExposureFraction: 0, maxAllowedExposureFraction: 0.5, openPositionCount: 0, maxSimultaneousPositions: 3,
      fractionalKellyFraction: 0.25, recommendedPositionSizeUnits: 9, recommendedDollarExposure: 9000, riskDollars: 90,
      passedAllChecks: true,
    },
    status: "PENDING_APPROVAL",
    approvalExpiryMs: 60000,
    supervisorNotes: "",
    supportingPersonas: ["a", "b", "c", "d"],
    dissentingPersonas: ["e"],
    personaVotesCast: 5,
    ...over,
  } as TradeProposal;
}

function props(proposals: TradeProposal[], over: Partial<LedgerQueueProps> = {}): LedgerQueueProps {
  return {
    proposals, onApprove: vi.fn(), onReject: vi.fn(), onApproveAll: vi.fn(), onScan: vi.fn(), isScanning: false,
    continuousScan: true, onContinuousScanChange: vi.fn(), autopilotOn: false, memoryCount: 412, ...over,
  };
}

describe("describeProposal", () => {
  it("turns a proposal into the card's numbers", () => {
    const d = describeProposal(proposal("p", "ETH/INR", 0.61));
    expect(d.action).toBe("Buy ETH/INR");
    expect(d.setupLabel).toBe("Trend following · 5 min");
    expect(d.winPct).toBe(61);
    expect(d.evR).toBeCloseTo(0.42, 2); // ₹126 EV on a ₹300 risk unit
    expect(d.riskInr).toBe(90); // 9 units × ₹10 to the stop
    expect(d.rewardInr).toBe(270);
    expect(d.agreement).toBe("4 of 5 analysts agree");
    expect(d.age).toBe("3 min ago");
    expect(d.held).toBeNull();
  });
});

describe("LedgerQueue", () => {
  it("puts the best chance of a win on top and lists the rest", () => {
    render(createElement(LedgerQueue, props([proposal("a", "XRP/INR", 0.55), proposal("b", "ETH/INR", 0.61)])));
    expect(screen.getByRole("article", { name: "Buy ETH/INR" })).toBeTruthy();
    const list = screen.getByRole("list", { name: "Other proposals" });
    expect(list.textContent).toContain("Buy XRP/INR");
  });

  it("approves or skips the proposal on top", () => {
    const p = props([proposal("b", "ETH/INR", 0.61)]);
    render(createElement(LedgerQueue, p));
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(p.onReject).toHaveBeenCalledWith("b", "Skipped by you in the queue");
    fireEvent.click(screen.getByRole("button", { name: "Approve paper trade" }));
    expect(p.onApprove).toHaveBeenCalledWith(p.proposals[0]);
    expect(screen.getByRole("button", { name: "Approving…" })).toBeTruthy();
  });

  it("names live trades as live", () => {
    render(createElement(LedgerQueue, props([proposal("b", "ETH/INR", 0.61)], { isLive: true })));
    expect(screen.getByRole("button", { name: "Approve live trade" })).toBeTruthy();
  });

  it("brings a listed proposal to the top when tapped", () => {
    render(createElement(LedgerQueue, props([proposal("a", "XRP/INR", 0.55), proposal("b", "ETH/INR", 0.61)])));
    fireEvent.click(within(screen.getByRole("list", { name: "Other proposals" })).getByRole("button"));
    expect(screen.getByRole("article", { name: "Buy XRP/INR" })).toBeTruthy();
  });

  it("says why autopilot held a proposal, and only offers approve-all for ready ones", () => {
    const held = proposal("h", "SOL/INR", 0.7, { status: "DEFERRED", deferralReason: "swing setup, manual approval only" });
    const p = props([held, proposal("a", "XRP/INR", 0.55), proposal("b", "ETH/INR", 0.61)], { autopilotOn: true });
    const { container } = render(createElement(LedgerQueue, p));
    expect(container.textContent).toContain("3 waiting · 1 held by autopilot");
    expect(container.textContent).toContain("Held by autopilot: swing setup, manual approval only");
    fireEvent.click(screen.getByRole("button", { name: "Approve all 2" }));
    expect(p.onApproveAll).toHaveBeenCalled();
  });

  it("shows an empty state and still lets you scan", () => {
    const p = props([], { continuousScan: false });
    const { container } = render(createElement(LedgerQueue, p));
    expect(container.textContent).toContain("Nothing to approve");
    expect(container.textContent).toContain("Scanning is paused");
    fireEvent.click(screen.getByRole("button", { name: "Scan markets now" }));
    expect(p.onScan).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("switch", { name: "Keep scanning" }));
    expect(p.onContinuousScanChange).toHaveBeenCalledWith(true);
  });
});
