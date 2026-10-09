// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LedgerFloor, riskLadder, rMultiple, type LedgerFloorProps } from "../../src/components/ledger/LedgerFloor";
import { formatMoney, formatPct, formatPrice } from "../../src/components/ledger/format";
import { HOLD_MS } from "../../src/components/ledger/ui";
import type { Position } from "../../src/types";

afterEach(cleanup);

describe("ledger number formatting", () => {
  it("uses Indian grouping, a real minus sign and optional plus", () => {
    expect(formatMoney(94483.96)).toBe("₹94,483.96");
    expect(formatMoney(-5688.13)).toBe("−₹5,688.13");
    expect(formatMoney(23.04, { signed: true })).toBe("+₹23.04");
    expect(formatMoney(0, { signed: true })).toBe("₹0.00");
    expect(formatMoney(2500, { decimals: 0 })).toBe("₹2,500");
  });

  it("drops decimals on large prices and keeps them on small ones", () => {
    expect(formatPrice(5842100.4)).toBe("58,42,100");
    expect(formatPrice(211.2)).toBe("211.20");
    expect(formatPrice(0.12345)).toBe("0.1235");
    expect(formatPct(0.333)).toBe("+0.33%");
    expect(formatPct(-1.2)).toBe("−1.20%");
  });
});

const btc: Position = {
  id: "p1", symbol: "BTC/INR", direction: "LONG", setupName: "t", entryPrice: 5842100, currentPrice: 5861300,
  quantity: 0.0012, stopLoss: 5851900, takeProfit: 5920000, unrealizedPnl: 23.04, unrealizedPnlPercent: 0.33,
  openTime: new Date().toISOString(), expectedHoldingTimeMinutes: 30, metaConfidence: 0.6, trailActive: true,
};

function props(over: Partial<LedgerFloorProps> = {}): LedgerFloorProps {
  return {
    isLive: false, equity: 94483.96, dailyPnl: 0, allTimePnl: -5688.13,
    autopilotOn: true, onAutopilotChange: vi.fn(), exposureFraction: 0.099, dailyLossLeft: 2500,
    stopped: false, onToggleStop: vi.fn(), positions: [btc], onClosePosition: vi.fn(),
    guardianOnline: true, liveTradingEnabled: false,
    market: [{ symbol: "BTC/INR", price: 5861300, changePercent: 0.31 }, { symbol: "ETH/INR", price: 265922.4, changePercent: -3.04 }],
    candleStatus: [],
    pendingProposals: 0, scan: { analyzed: 42, selected: 6, rejected: 36 }, onOpenQueue: vi.fn(), onOpenSettings: vi.fn(),
    ...over,
  };
}

describe("LedgerFloor", () => {
  it("shows the account, limits and positions from its props", () => {
    const { container } = render(createElement(LedgerFloor, props()));
    const text = container.textContent ?? "";
    // Paper equity: the paper money and the open trade's profit (₹94,483.96 + ₹23.04).
    expect(text).toContain("Paper equity₹94,507.00");
    expect(text).toContain("−₹5,688.13");
    // The money ring: free cash is the paper money less what the open trade took (0.0012 BTC at ₹58,42,100 is
    // ₹7,010.52, and CoinDCX's 0.59% to open it ₹41.36), and the ring is filled to the share in trades (7.5%).
    expect(screen.getByTestId("free-cash").textContent).toBe("Free cash₹87,432.08");
    expect(screen.getByTestId("in-trades").textContent).toBe("In 1 trade₹7,052");
    expect(screen.getByTestId("money-ring").textContent).toBe("7%in trades");
    expect(screen.getByTestId("money-ring").style.getPropertyValue("--nx-ring")).toBe("7.5");
    // The ring says what's in trades, so the autopilot card doesn't repeat it on paper.
    expect(text).not.toContain("9.9%");
    expect(text).toContain("₹2,500");
    expect(text).toContain("Trailing stop active · locked above entry");
    expect(text).toContain("Guardian online · live trading off");
    expect(text).toContain("BTC 58,61,300 +0.31% · ETH 2,65,922 \u22123.04% in 24h");
  });

  it("shows CoinDCX's balance as it is when live, with no paper free cash", () => {
    const { container } = render(createElement(LedgerFloor, props({ isLive: true })));
    expect(container.textContent).toContain("CoinDCX equity₹94,483.96");
    expect(screen.queryByTestId("free-cash")).toBeNull();
    expect(screen.queryByTestId("money-ring")).toBeNull();
    expect(container.textContent).toContain("In trades · 9.9%");
  });

  it("says when half a position has been banked", () => {
    const banked = { ...btc, quantity: 0.002, bankedQuantity: 0.001, bankedPrice: 5852000 };
    const { container } = render(createElement(LedgerFloor, props({ positions: [banked] })));
    expect(container.textContent).toContain("Half banked at +1R · 0.001 left on the trailing stop");
  });

  it("says how many coins the scanner is watching", () => {
    const { container, rerender } = render(createElement(LedgerFloor, props({ watching: { count: 25, fallback: false } })));
    expect(container.textContent).toContain("Watching CoinDCX's 25 most-traded coins, updated hourly");
    rerender(createElement(LedgerFloor, props({ watching: { count: 7, fallback: true } })));
    expect(container.textContent).toContain("Watching 7 default coins until CoinDCX's most-traded list loads");
  });

  it("closes a position only when Close is held, not on a tap or a short press", () => {
    vi.useFakeTimers();
    try {
      const p = props();
      render(createElement(LedgerFloor, p));
      const button = () => screen.getByRole("button", { name: /hold/i });
      expect(button().textContent).toBe("Hold to close");
      fireEvent.click(button());
      fireEvent.pointerDown(button());
      act(() => vi.advanceTimersByTime(HOLD_MS - 200));
      fireEvent.pointerUp(button());
      act(() => vi.advanceTimersByTime(HOLD_MS));
      expect(p.onClosePosition).not.toHaveBeenCalled();
      // Letting go early says what to do, then goes back.
      expect(button().textContent).toBe("Keep holding to close");
      act(() => vi.advanceTimersByTime(2100));
      expect(button().textContent).toBe("Hold to close");

      fireEvent.pointerDown(button());
      expect((screen.getByTestId("hold-fill") as HTMLElement).style.transform).toBe("scaleX(1)");
      act(() => vi.advanceTimersByTime(HOLD_MS));
      expect(p.onClosePosition).toHaveBeenCalledTimes(1);
      expect(p.onClosePosition).toHaveBeenCalledWith(btc);
      fireEvent.pointerUp(button());
      expect(p.onClosePosition).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes with the keyboard by holding Space or Enter, and stops if a scroll takes the finger", () => {
    vi.useFakeTimers();
    try {
      const p = props();
      render(createElement(LedgerFloor, p));
      const button = screen.getByRole("button", { name: "Hold to close" });
      fireEvent.pointerDown(button);
      fireEvent.pointerCancel(button);
      act(() => vi.advanceTimersByTime(HOLD_MS * 2));
      expect(p.onClosePosition).not.toHaveBeenCalled();
      expect(button.textContent).toBe("Hold to close");
      fireEvent.keyDown(button, { key: " " });
      act(() => vi.advanceTimersByTime(HOLD_MS));
      expect(p.onClosePosition).toHaveBeenCalledWith(btc);
    } finally {
      vi.useRealTimers();
    }
  });

  it("toggles autopilot, and locks it while everything is stopped", () => {
    const p = props();
    const { rerender } = render(createElement(LedgerFloor, p));
    fireEvent.click(screen.getByRole("switch", { name: "Autopilot" }));
    expect(p.onAutopilotChange).toHaveBeenCalledWith(false);

    rerender(createElement(LedgerFloor, { ...p, stopped: true }));
    expect((screen.getByRole("switch", { name: "Autopilot" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Resume/ }));
    expect(p.onToggleStop).toHaveBeenCalled();
  });

  it("warns when coins have no price candles, with CoinDCX's reason", () => {
    const { container } = render(
      createElement(LedgerFloor, props({
        candleStatus: [
          { symbol: "BTC/INR", bars: 0, checkedAt: 1, error: "CoinDCX candles (I-BTC_INR, 5m): HTTP 400 bad pair" },
          { symbol: "ETH/INR", bars: 299, checkedAt: 1 },
        ],
      }))
    );
    expect(container.textContent).toContain("No price candles for 1 of 2 coins");
    expect(container.textContent).toContain("(BTC)");
    expect(container.textContent).toContain("HTTP 400 bad pair");
  });

  it("lists today's main reasons for skipping", () => {
    const { container } = render(
      createElement(LedgerFloor, props({ scan: { analyzed: 10, selected: 1, rejected: 9, skipReasons: { no_setup: 6, low_confidence: 3 } } }))
    );
    expect(container.textContent).toContain("No trader's rules matched · 67%");
    expect(container.textContent).toContain("Chance of a win too low · 33%");
  });

  it("links to the queue when proposals are waiting", () => {
    const p = props({ pendingProposals: 2, positions: [] });
    const { container } = render(createElement(LedgerFloor, p));
    expect(container.textContent).toContain("No open positions");
    fireEvent.click(screen.getByRole("button", { name: /2 proposals waiting/ }));
    expect(p.onOpenQueue).toHaveBeenCalled();
  });
});

describe("what the server did while the app was closed", () => {
  it("says when the server last scanned and traded, and marks the positions it opened", () => {
    const now = Date.now();
    render(
      createElement(
        LedgerFloor,
        props({
          scanLocation: "server",
          lastServerScanAt: now - 4 * 60_000,
          lastServerOpenAt: now - 30 * 60_000,
          positions: [{ ...btc, openedByServer: true, openTime: new Date(now - 30 * 60_000).toISOString() }],
        })
      )
    );
    const line = screen.getByLabelText("Server autopilot").textContent ?? "";
    expect(line).toMatch(/^Server: last scan 4 min ago · last trade \d/);
    expect(screen.getByText(/^Opened by the server at /)).toBeTruthy();
  });

  it("says so when the server hasn't traded yet, and says nothing when autopilot is off", () => {
    const { unmount } = render(createElement(LedgerFloor, props({ scanLocation: "server", lastServerScanAt: Date.now(), lastServerOpenAt: 0 })));
    expect(screen.getByLabelText("Server autopilot").textContent).toMatch(/last scan just now · last trade none yet/);
    // With the heartbeat: the countdown to the next scan and the last hour of scans.
    expect(screen.getByTestId("scan-heartbeat").textContent).toMatch(/Next scan in \d:\d\d|Scanning now…/);
    unmount();
    render(createElement(LedgerFloor, props({ scanLocation: "server", autopilotOn: false })));
    expect(screen.queryByLabelText("Server autopilot")).toBeNull();
    expect(screen.queryByTestId("scan-heartbeat")).toBeNull();
    expect(screen.queryByText(/Opened by the server/)).toBeNull();
  });
});

describe("autopilot in Live mode", () => {
  it("says the server places real orders when it allows live orders, and that trades wait when it doesn't", () => {
    const { container, rerender } = render(
      createElement(LedgerFloor, props({ isLive: true, autopilotOn: true, scanLocation: "server", liveTradingEnabled: true }))
    );
    const card = () => container.querySelector('[aria-label="Autopilot"]')!;
    expect(card().textContent).toMatch(/Live · places real CoinDCX orders from the server within your limits, even with the app closed/);
    expect(card().textContent).toMatch(/stock trades wait for you/);
    expect(screen.getByLabelText("Server autopilot")).toBeTruthy();
    rerender(createElement(LedgerFloor, props({ isLive: true, autopilotOn: true, scanLocation: "server", liveTradingEnabled: false })));
    expect(card().textContent).toMatch(/Live orders are blocked on the server, so live trades wait for you/);
    expect(screen.queryByLabelText("Server autopilot")).toBeNull();
  });
});

// A US breakout trade: bought at ₹100 with the stop at ₹90 (1R = ₹10 a share), now ₹115.
const breakout: Position = {
  ...btc, id: "b1", symbol: "NVDA.US", strategy: "breakout", entryPrice: 100, currentPrice: 115, quantity: 4, stopLoss: 90, initialStopLoss: 90,
  takeProfit: 0, unrealizedPnl: 60, unrealizedPnlPercent: 15, trailActive: false, openedByServer: true, openTime: new Date(2026, 9, 5, 1, 15).toISOString(),
};

describe("a trade's line in R (breakout and momentum have no target)", () => {
  it("runs from past the first stop to beyond +2R, further as the price runs, with a tick at each whole R", () => {
    expect(rMultiple(breakout, 115)).toBeCloseTo(1.5);
    expect(rMultiple({ ...breakout, direction: "SHORT", stopLoss: 110, initialStopLoss: 110 }, 85)).toBeCloseTo(1.5);
    expect(rMultiple({ ...breakout, initialStopLoss: 100 }, 115)).toBeNull();
    // −1.3R to +2.3R: the stop at −1R, the entry at 0, now at +1.5R.
    const l = riskLadder(breakout, 115)!;
    expect(l.stop).toBeCloseTo(0.3 / 3.6);
    expect(l.entry).toBeCloseTo(1.3 / 3.6);
    expect(l.now).toBeCloseTo(2.8 / 3.6);
    expect(l.ticks.map((t) => t.r)).toEqual([1, 2]);
    // At +5R the line reaches +5.3R; at +10R it marks every second R.
    expect(riskLadder(breakout, 150)!.ticks.map((t) => t.r)).toEqual([1, 2, 3, 4, 5]);
    expect(riskLadder(breakout, 200)!.ticks.map((t) => t.r)).toEqual([2, 4, 6, 8, 10]);
  });

  it("draws a breakout trade on its R line with where it stands, and a target trade on its stop-to-target line", () => {
    render(createElement(LedgerFloor, props({ positions: [breakout, btc] })));
    const tracks = screen.getAllByTestId("risk-track");
    expect(tracks).toHaveLength(1);
    expect(tracks[0].querySelectorAll("[data-testid=r-tick]")).toHaveLength(2);
    expect((tracks[0].querySelector("[data-testid=position-marker]") as HTMLElement).style.left).toBe("77.78%");
    expect(screen.getAllByTestId("position-track")).toHaveLength(1);
    // The R pill: the breakout trade is up 1.5R; the BTC trade's first stop is above its entry, so it has none.
    expect(screen.getAllByTestId("r-pill").map((e) => e.textContent)).toEqual(["+1.50R"]);
  });

  it("folds a trade's numbers open when tapped, and away again", () => {
    render(createElement(LedgerFloor, props({ positions: [breakout] })));
    const head = screen.getByRole("button", { name: "NVDA.US: show its numbers" });
    const numbers = screen.getByTestId("position-numbers");
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(numbers.className).not.toContain("nx-fold-open");
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(numbers.className).toContain("nx-fold-open");
    // ₹400 in it; −₹40 at the stop (4 shares, ₹10 each); 1R is ₹40; opened by the server.
    expect(numbers.textContent).toContain("Money in it₹400");
    expect(numbers.textContent).toContain("At the stop, before fees−₹40");
    expect(numbers.textContent).toContain("Risk at the start (1R)₹40");
    expect(numbers.textContent).toContain("· server");
    fireEvent.click(screen.getByRole("button", { name: "NVDA.US: hide its numbers" }));
    expect(numbers.className).not.toContain("nx-fold-open");
  });

  it("says what a stop above the entry locks in", () => {
    render(createElement(LedgerFloor, props({ positions: [{ ...breakout, stopLoss: 105 }] })));
    expect(screen.getByTestId("position-numbers").textContent).toContain("At the stop, before fees+₹20 locked in");
  });
});
