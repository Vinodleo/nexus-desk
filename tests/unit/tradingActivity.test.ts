// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_TRADING_ACTIVITY, tradesTooRarely, tradingActivity } from "../../src/services/tradingActivity";
import { _resetScannedCandles, scanAllMarkets } from "../../src/services/marketScannerService";
import { measureExpectancy } from "../../src/services/exitExpectancy";
import { toClosedBars } from "../../src/services/liveMarketStreamService";
import { breakdown } from "../../src/components/ledger/LedgerBreakdown";
import type { HistoricalTrade, MarketBar } from "../../src/types";

// Coins that go minutes without a trade jump between trades, so a stop fills
// past where it was set. They aren't traded.

vi.spyOn(console, "warn").mockImplementation(() => {});

const FIVE_MIN = 5 * 60 * 1000;
function candles(n: number, priceAt: (i: number) => number, activeMinutes?: number): MarketBar[] {
  const lastOpen = Math.floor(Date.now() / FIVE_MIN) * FIVE_MIN - FIVE_MIN;
  return Array.from({ length: n }, (_, i) => {
    const c = priceAt(i);
    return {
      time: String(i),
      timestampMs: lastOpen - (n - 1 - i) * FIVE_MIN,
      open: c - 2,
      high: c + 4,
      low: c - 4,
      close: c,
      volume: 100 + i,
      ...(activeMinutes !== undefined ? { activeMinutes } : {}),
    };
  });
}

const baseOptions = {
  activePositions: [],
  dailyRealizedPnl: 0,
  experiences: [],
  failureState: {
    globalKillSwitchActive: false, simulateAgentTimeout: false, simulateStaleMarketData: false,
    simulateDailyLossBreach: false, simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false,
  },
};

describe("tradingActivity", () => {
  it("is the share of the last two hours' minutes with a trade", () => {
    expect(tradingActivity(candles(30, () => 100, 2))).toBeCloseTo(0.4, 6);
    expect(tradingActivity(candles(30, () => 100, 5))).toBe(1);
    expect(tradesTooRarely(candles(30, () => 100, 2))).toBe(true);
    expect(tradesTooRarely(candles(30, () => 100, 3))).toBe(false); // 60%
    expect(MIN_TRADING_ACTIVITY).toBe(0.5);
  });

  it("says nothing when the candles don't record it (stocks, older candles)", () => {
    expect(tradingActivity(candles(30, () => 100))).toBeNull();
    expect(tradesTooRarely(candles(30, () => 100))).toBe(false);
    expect(tradingActivity(null)).toBeNull();
  });

  it("is read from the server's candles", () => {
    const now = Date.now();
    const t = Math.floor(now / FIVE_MIN) * FIVE_MIN - 2 * FIVE_MIN;
    const [bar] = toClosedBars([{ time: t, open: 1, high: 2, low: 1, close: 2, volume: 5, activeMinutes: 3 }], FIVE_MIN, now);
    expect(bar.activeMinutes).toBe(3);
  });
});

describe("the scanner with a coin that trades rarely", () => {
  beforeEach(() => _resetScannedCandles());

  it("skips the coin, and still follows the setup to see if that was right", async () => {
    const trend = (active: number) => candles(150, (i) => 10000 + i * 8, active);
    const rare = await scanAllMarkets({ ...baseOptions, symbols: ["ZEC/INR"], barsMap: { "ZEC/INR": trend(2) } });
    expect(rare.outcomes).toEqual([{ symbol: "ZEC/INR", proposed: false, reason: "thin_trading" }]);
    expect(rare.shadows.some((s) => s.kind === "thin_trading")).toBe(true);

    _resetScannedCandles();
    const busy = await scanAllMarkets({ ...baseOptions, symbols: ["ZEC/INR"], barsMap: { "ZEC/INR": trend(5) } });
    expect(busy.outcomes).toEqual([{ symbol: "ZEC/INR", proposed: true }]);
    expect(busy.newProposals[0].dataQuality?.tradingActivity).toBe(1);
  });

  it("leaves such coins out of the traders' records", () => {
    const rising = (active: number) => candles(300, (i) => 10000 + i * 8, active);
    expect(measureExpectancy([{ symbol: "ZEC/INR", bars: rising(1) }]).symbols).toBe(0);
    expect(measureExpectancy([{ symbol: "SOL/INR", bars: rising(5) }]).symbols).toBe(1);
  });
});

describe("the Book's breakdown", () => {
  it("shows how far stop exits sold past their stops", () => {
    const t = (over: Partial<HistoricalTrade>): HistoricalTrade =>
      ({ id: Math.random().toString(36), symbol: "ZEC/INR", direction: "LONG", setupName: "Chen", entryPrice: 154000, exitPrice: 151230,
         quantity: 0.061, moneyPlaced: 9394, realizedPnl: -178, realizedPnlPercent: -1.9, isWin: false, exitReason: "STOP_LOSS",
         openedAt: "", closedAt: "", ...over }) as HistoricalTrade;
    const [zec] = breakdown([t({ stopAtExit: 151575, fillAtExit: 151230 }), t({ stopAtExit: 151575, fillAtExit: 151575 })], (x) => x.symbol);
    // 0.23% and 0%: 0.11% on average.
    expect(zec.avgSlipPct).toBeCloseTo(((151575 - 151230) / 151575) * 50, 6);
    expect(breakdown([t({ exitReason: "TAKE_PROFIT" })], (x) => x.symbol)[0].avgSlipPct).toBeNull();
  });
});
