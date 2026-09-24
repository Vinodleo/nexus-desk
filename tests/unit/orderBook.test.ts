// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { averageFill, bookStats, depthScoreFor, parseCoinDcxOrderBook, type RawBook } from "../../src/shared/orderBook";
import { toOrderBook } from "../../src/services/orderBookService";
import { evaluateExpectedValue } from "../../src/services/riskEngine";
import { _resetScannedCandles, scanAllMarkets } from "../../src/services/marketScannerService";
import type { MarketBar, MetaLabelScore, StrategySetup } from "../../src/types";

vi.spyOn(console, "warn").mockImplementation(() => {});

describe("parsing CoinDCX's order book", () => {
  it("reads the price-to-quantity maps, best levels first", () => {
    const book = parseCoinDcxOrderBook(
      { bids: { "99": "2", "100": "1", "98": "0" }, asks: { "102": "3", "101": "1.5" } },
      1234
    )!;
    expect(book.bids).toEqual([[100, 1], [99, 2]]); // zero quantity dropped
    expect(book.asks).toEqual([[101, 1.5], [102, 3]]);
    expect(book.fetchedAt).toBe(1234);
  });

  it("reads level arrays too, and rejects empty or crossed books", () => {
    expect(parseCoinDcxOrderBook({ bids: [["100", "1"]], asks: [{ price: "101", quantity: "2" }] })!.asks).toEqual([[101, 2]]);
    expect(parseCoinDcxOrderBook({ bids: {}, asks: { "101": "1" } })).toBeNull();
    expect(parseCoinDcxOrderBook({ bids: { "102": "1" }, asks: { "101": "1" } })).toBeNull();
    expect(parseCoinDcxOrderBook("nope")).toBeNull();
  });
});

describe("what the book means for a trade", () => {
  const book: RawBook = {
    bids: [[100, 10], [99, 100]],
    asks: [[101, 10], [102, 100]],
    fetchedAt: 0,
  };

  it("walks the levels for the average fill", () => {
    expect(averageFill(book.asks, 505)).toBe(101); // fits in the first level
    // ₹1010 at 101 (10 units) + ₹1020 at 102 (10 units) = ₹2030 for 20 units
    expect(averageFill(book.asks, 2030)).toBeCloseTo(101.5, 6);
    expect(averageFill(book.asks, 1e9)).toBeNull(); // more than the book holds
  });

  it("measures spread, slippage past the best price, and depth near the price", () => {
    const small = bookStats(book, 500);
    expect(small.spread).toBe(1);
    expect(small.mid).toBe(100.5);
    expect(small.roundTripSlippage).toBe(0);
    const big = bookStats(book, 2030);
    expect(big.roundTripSlippage).toBeGreaterThan(0.004);
    expect(bookStats(book, 1e9).roundTripSlippage).toBe(Infinity);
    // Within 0.5% of 100.5 (100.0..101.0): ₹1000 of bids and ₹1010 of asks; the thinner side counts.
    expect(small.depthInr).toBe(1000);
  });

  it("scores depth by how many trades fit near the price", () => {
    expect(depthScoreFor(10_000, 10_000)).toBe(35);
    expect(depthScoreFor(200_000, 10_000)).toBe(100);
    expect(depthScoreFor(5_000, 10_000)).toBeLessThan(35);
    expect(depthScoreFor(0, 10_000)).toBe(0);
  });

  it("becomes the scanner's order book, marked as CoinDCX's", () => {
    const ob = toOrderBook(book, 500);
    expect(ob).toMatchObject({ source: "coindcx", spread: 1, midPrice: 100.5, roundTripSlippage: 0 });
    expect(ob.asks[1]).toEqual({ price: 102, size: 100, total: 110 });
  });
});

describe("costs use measured slippage", () => {
  const setup = { symbol: "SOL/INR", direction: "LONG", entryPrice: 10000, stopLoss: 9970, takeProfit: 10066 } as StrategySetup;
  const meta = { calibratedWinProbability: 0.6 } as MetaLabelScore;

  it("prices slippage from the book when it's known", () => {
    const estimated = evaluateExpectedValue(setup, meta, 1, 88);
    const measured = evaluateExpectedValue(setup, meta, 1, 88, undefined, 0.002);
    expect(measured.estimatedSlippageCost).toBeCloseTo(estimated.estimatedSlippageCost * 10, 2);
    // A book that can't fill the trade is costed at 1%, not infinity.
    expect(Number.isFinite(evaluateExpectedValue(setup, meta, 1, 0, undefined, Infinity).expectedNetValue)).toBe(true);
  });
});

describe("scanner with the live book", () => {
  beforeEach(() => _resetScannedCandles());

  const FIVE_MIN = 5 * 60 * 1000;
  const lastOpen = Math.floor(Date.now() / FIVE_MIN) * FIVE_MIN - FIVE_MIN;
  const trend: MarketBar[] = Array.from({ length: 150 }, (_, i) => {
    const c = 10000 + i * 8;
    return { time: String(i), timestampMs: lastOpen - (149 - i) * FIVE_MIN, open: c - 2, high: c + 4, low: c - 4, close: c, volume: 100 + i };
  });
  const baseOptions = {
    activePositions: [],
    dailyRealizedPnl: 0,
    experiences: [],
    symbols: ["SOL/INR"],
    barsMap: { "SOL/INR": trend },
    failureState: {
      globalKillSwitchActive: false, simulateAgentTimeout: false, simulateStaleMarketData: false,
      simulateDailyLossBreach: false, simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false,
    },
  };
  const last = trend[trend.length - 1].close;
  const deep: RawBook = {
    bids: [[last - 1, 100], [last - 2, 100]],
    asks: [[last + 1, 100], [last + 2, 100]],
    fetchedAt: Date.now(),
  };

  it("uses CoinDCX's book for a coin with a setup", async () => {
    const getOrderBook = vi.fn(async (_s: string, notional: number) => toOrderBook(deep, notional));
    const report = await scanAllMarkets({ ...baseOptions, getOrderBook });
    expect(getOrderBook).toHaveBeenCalledWith("SOL/INR", expect.any(Number));
    const p = report.newProposals[0];
    expect(p.dataQuality?.simulatedOrderBook).toBe(false);
    expect(p.marketAnalysisSummary).toMatch(/CoinDCX order book/);
  });

  it("rejects a trade the real book is too thin for", async () => {
    const thin: RawBook = { bids: [[last - 1, 0.01]], asks: [[last + 1, 0.01]], fetchedAt: Date.now() };
    const report = await scanAllMarkets({ ...baseOptions, getOrderBook: async (_s, n) => toOrderBook(thin, n) });
    expect(report.newProposals).toEqual([]);
    expect(report.outcomes[0]).toMatchObject({ proposed: false, reason: "thin_market" });
  });

  it("falls back to the simulated book when CoinDCX's can't be read", async () => {
    const report = await scanAllMarkets({ ...baseOptions, getOrderBook: async () => null });
    expect(report.newProposals[0].dataQuality?.simulatedOrderBook).toBe(true);
  });
});
