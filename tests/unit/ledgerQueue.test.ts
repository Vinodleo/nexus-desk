// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LedgerQueue, UNDO_MS, describeProposal, type LedgerQueueProps } from "../../src/components/ledger/LedgerQueue";
import { swipeOutcome } from "../../src/components/ledger/SwipeCard";
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

// Swipe right to approve, left to skip; either waits behind Undo first.

// jsdom has no PointerEvent; a MouseEvent with a pointer id is enough here.
if (typeof window !== "undefined" && !(window as any).PointerEvent) {
  (window as any).PointerEvent = class extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, init: any = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "touch";
    }
  };
}

function swipe(dx: number, dy = 0) {
  const card = screen.getByTestId("swipe-card");
  fireEvent.pointerDown(card, { pointerId: 1, clientX: 200, clientY: 300 });
  for (let k = 1; k <= 4; k++) fireEvent.pointerMove(card, { pointerId: 1, clientX: 200 + (dx * k) / 4, clientY: 300 + (dy * k) / 4 });
  fireEvent.pointerUp(card, { pointerId: 1, clientX: 200 + dx, clientY: 300 + dy });
  act(() => vi.advanceTimersByTime(300)); // flies off
}

describe("swiping", () => {
  afterEach(() => vi.useRealTimers());

  it("commits past a clear distance or a quick flick, and springs back otherwise", () => {
    expect(swipeOutcome(150, 320, 0.1)).toBe("right");
    expect(swipeOutcome(-150, 320, -0.1)).toBe("left");
    expect(swipeOutcome(90, 320, 0.1)).toBeNull();
    expect(swipeOutcome(70, 320, 1)).toBe("right");
    expect(swipeOutcome(40, 320, 2)).toBeNull();
    // A flick back the other way doesn't count.
    expect(swipeOutcome(70, 320, -1)).toBeNull();
  });

  it("approves after the undo time, not before", () => {
    vi.useFakeTimers();
    const p = props([proposal("b", "ETH/INR", 0.61)]);
    render(createElement(LedgerQueue, p));
    swipe(180);
    expect(screen.getByRole("status").textContent).toMatch(/Approving Buy ETH\/INR/);
    expect(screen.queryByRole("article", { name: "Buy ETH/INR" })).toBeNull();
    // The wait starts once the card has flown off (inside swipe()).
    act(() => vi.advanceTimersByTime(UNDO_MS - 400));
    expect(p.onApprove).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(400));
    expect(p.onApprove).toHaveBeenCalledTimes(1);
    expect((p.onApprove as any).mock.calls[0][0].id).toBe("b");
  });

  it("puts the card back on Undo, and nothing is approved", () => {
    vi.useFakeTimers();
    const p = props([proposal("b", "ETH/INR", 0.61)]);
    render(createElement(LedgerQueue, p));
    swipe(180);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("article", { name: "Buy ETH/INR" })).toBeTruthy();
    act(() => vi.advanceTimersByTime(UNDO_MS * 2));
    expect(p.onApprove).not.toHaveBeenCalled();
    expect(p.onReject).not.toHaveBeenCalled();
  });

  it("skips with a swipe left, also after the undo time", () => {
    vi.useFakeTimers();
    const p = props([proposal("b", "ETH/INR", 0.61)]);
    render(createElement(LedgerQueue, p));
    swipe(-180);
    expect(screen.getByRole("status").textContent).toMatch(/Skipping Buy ETH\/INR/);
    act(() => vi.advanceTimersByTime(UNDO_MS));
    expect(p.onReject).toHaveBeenCalledWith("b", "Skipped by you in the queue");
  });

  it("ignores a short drag, a scroll, and the tap that ends a swipe", () => {
    vi.useFakeTimers();
    const p = props([proposal("b", "ETH/INR", 0.61)]);
    render(createElement(LedgerQueue, p));
    swipe(60);
    swipe(30, 200);
    expect(screen.queryByRole("status")).toBeNull();
    // A drag that ends over the Approve button doesn't also press it.
    const button = screen.getByRole("button", { name: "Approve paper trade" });
    fireEvent.pointerDown(button, { pointerId: 2, clientX: 100, clientY: 300 });
    fireEvent.pointerMove(button, { pointerId: 2, clientX: 140, clientY: 300 });
    fireEvent.pointerUp(button, { pointerId: 2, clientX: 140, clientY: 300 });
    fireEvent.click(button);
    expect(p.onApprove).not.toHaveBeenCalled();
    // The next real tap works.
    fireEvent.pointerDown(button, { pointerId: 3, clientX: 100, clientY: 300 });
    fireEvent.pointerUp(button, { pointerId: 3, clientX: 100, clientY: 300 });
    fireEvent.click(button);
    expect(p.onApprove).toHaveBeenCalledTimes(1);
  });

  it("won't approve a live trade by swipe; the button does that", () => {
    vi.useFakeTimers();
    const p = props([proposal("b", "ETH/INR", 0.61)], { isLive: true });
    render(createElement(LedgerQueue, p));
    expect(screen.getByText(/live trades are approved with the button/)).toBeTruthy();
    swipe(220);
    act(() => vi.advanceTimersByTime(UNDO_MS * 2));
    expect(screen.queryByRole("status")).toBeNull();
    expect(p.onApprove).not.toHaveBeenCalled();
  });

  it("lets a waiting swipe through when leaving the Queue or swiping the next card", () => {
    vi.useFakeTimers();
    const p = props([proposal("a", "XRP/INR", 0.55), proposal("b", "ETH/INR", 0.61)]);
    const { unmount } = render(createElement(LedgerQueue, p));
    swipe(180); // ETH, the best, is on top
    swipe(-180); // then XRP
    expect((p.onApprove as any).mock.calls.map((c: any) => c[0].id)).toEqual(["b"]);
    unmount();
    expect(p.onReject).toHaveBeenCalledWith("a", "Skipped by you in the queue");
  });

  it("drops it if the proposal expired while waiting", () => {
    vi.useFakeTimers();
    const p = props([proposal("b", "ETH/INR", 0.61)]);
    const { rerender } = render(createElement(LedgerQueue, p));
    swipe(180);
    rerender(createElement(LedgerQueue, { ...p, proposals: [proposal("b", "ETH/INR", 0.61, { status: "EXPIRED" as any })] }));
    act(() => vi.advanceTimersByTime(UNDO_MS));
    expect(p.onApprove).not.toHaveBeenCalled();
  });
});

describe("the Queue in Live mode", () => {
  it("says the server's autopilot places live orders, and offers no approve-all", () => {
    render(
      createElement(
        LedgerQueue,
        props([proposal("a", "XRP/INR", 0.55), proposal("b", "ETH/INR", 0.61), proposal("c", "SOL/INR", 0.58)], {
          autopilotOn: true,
          isLive: true,
          onApproveAll: undefined,
        })
      )
    );
    expect(screen.getByText(/Live mode: the server's autopilot places real CoinDCX orders within your limits/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Approve all/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Approve live trade" })).toBeTruthy();
  });
});
