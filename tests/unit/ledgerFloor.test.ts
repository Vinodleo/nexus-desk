// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LedgerFloor, type LedgerFloorProps } from "../../src/components/ledger/LedgerFloor";
import { formatMoney, formatPct, formatPrice } from "../../src/components/ledger/format";
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
    expect(text).toContain("₹94,483.96");
    expect(text).toContain("−₹5,688.13");
    expect(text).toContain("9.9%");
    expect(text).toContain("₹2,500");
    expect(text).toContain("Trailing stop active · locked above entry");
    expect(text).toContain("Guardian online · live trading off");
    expect(text).toContain("BTC 58,61,300 +0.31% · ETH 2,65,922 \u22123.04% in 24h");
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

  it("closes a position only on the second tap", () => {
    const p = props();
    render(createElement(LedgerFloor, p));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(p.onClosePosition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Tap again to close" }));
    expect(p.onClosePosition).toHaveBeenCalledWith(btc);
  });

  it("forgets a half-finished close after a few seconds", () => {
    vi.useFakeTimers();
    try {
      render(createElement(LedgerFloor, props()));
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      act(() => {
        vi.advanceTimersByTime(4500);
      });
      expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
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
    unmount();
    render(createElement(LedgerFloor, props({ scanLocation: "server", autopilotOn: false })));
    expect(screen.queryByLabelText("Server autopilot")).toBeNull();
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
