// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetScannedCandles, scanAllMarkets } from "../../src/services/marketScannerService";
import {
  EXPECTANCY_TTL_MS,
  MIN_MARKET_TRADES,
  _clearExpectancyCache,
  exitEdgeFor,
  getExpectancyTable,
  marketIsFalling,
  marketTrendFrom,
  measureExpectancy,
  shrunkR,
  type ExpectancyTable,
} from "../../src/services/exitExpectancy";
import { breakdown, payoffSummary } from "../../src/components/ledger/LedgerBreakdown";
import { riskAtOpen } from "../../src/shared/exitRules";
import type { HistoricalTrade, MarketBar } from "../../src/types";

// The loss fixes: trades judged by what the live exits actually earn, coin
// longs held back while Bitcoin falls, and the Book's breakdown.

vi.spyOn(console, "warn").mockImplementation(() => {});

const FIVE_MIN = 5 * 60 * 1000;
function candles(n: number, priceAt: (i: number) => number): MarketBar[] {
  const lastOpen = Math.floor(Date.now() / FIVE_MIN) * FIVE_MIN - FIVE_MIN;
  return Array.from({ length: n }, (_, i) => {
    const c = priceAt(i);
    return { time: String(i), timestampMs: lastOpen - (n - 1 - i) * FIVE_MIN, open: c - 2, high: c + 4, low: c - 4, close: c, volume: 100 + i };
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

const trend = () => candles(150, (i) => 10000 + i * 8);

describe("measuring traders with the live exits", () => {
  beforeEach(() => _clearExpectancyCache());

  it("plays each trader's setups forward with the exits, after fees", () => {
    const rising = candles(300, (i) => 10000 + i * 8);
    const table = measureExpectancy([{ symbol: "SOL/INR", bars: rising }], "tight");
    const records = Object.entries(table.byKey);
    expect(table.symbols).toBe(1);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every(([k]) => k.startsWith("crypto:"))).toBe(true);
    // A steady climb: long setups make money even after fees.
    expect(records.reduce((a, [, r]) => a + r.totalR, 0)).toBeGreaterThan(0);
  });

  it("skips generated or too-short history", () => {
    const short = candles(50, (i) => 10000 + i);
    const fake = candles(300, (i) => 10000 + i).map((b) => ({ ...b, isSynthetic: true }));
    expect(measureExpectancy([{ symbol: "A/INR", bars: short }, { symbol: "B/INR", bars: fake }]).symbols).toBe(0);
  });

  it("judges a trader only once its market has enough measured setups, shrinking thin records toward break-even", () => {
    const table: ExpectancyTable = {
      profile: "tight",
      measuredAt: 0,
      symbols: 10,
      byKey: { "crypto:Priya Momentum Scalp": { trades: 12, totalR: 6, wins: 8, winR: 8, lossR: -2 } },
    };
    // 12 setups across the market: not enough to judge anyone yet.
    expect(exitEdgeFor(table, "SOL/INR", "Priya Momentum Scalp")).toBeNull();
    table.byKey["crypto:Chen Conservative Trend"] = { trades: MIN_MARKET_TRADES, totalR: -9, wins: 5, winR: 2, lossR: -11 };
    // +0.5R on 12 trades counts as 6 / (12 + 8) = +0.3R.
    expect(exitEdgeFor(table, "SOL/INR", "Priya Momentum Scalp")).toEqual({ r: 0.3, trades: 12 });
    expect(exitEdgeFor(table, "SOL/INR", "Chen Conservative Trend")!.r).toBeLessThan(0);
    // A trader with no record at all is at break-even: not enough to trade on.
    expect(exitEdgeFor(table, "SOL/INR", "Nobody")).toEqual({ r: 0, trades: 0 });
    // Stocks are judged separately.
    expect(exitEdgeFor(table, "SBIN", "Priya Momentum Scalp")).toBeNull();
    expect(shrunkR(undefined)).toBe(0);
  });

  it("is measured once an hour per trail profile", () => {
    const bars = candles(300, (i) => 10000 * Math.pow(1.002, i));
    const getBars = vi.fn(() => bars);
    const t0 = Date.now();
    const a = getExpectancyTable(["SOL/INR"], getBars, "tight", t0);
    expect(getExpectancyTable(["SOL/INR"], getBars, "tight", t0 + 60_000)).toBe(a);
    expect(getBars).toHaveBeenCalledTimes(1);
    expect(getExpectancyTable(["SOL/INR"], getBars, "patient", t0)).not.toBe(a);
    expect(getExpectancyTable(["SOL/INR"], getBars, "tight", t0 + EXPECTANCY_TTL_MS)).not.toBe(a);
  });
});

describe("the scanner", () => {
  beforeEach(() => _resetScannedCandles());

  it("holds coin longs back while Bitcoin falls, and follows them to see if that was right", async () => {
    const opts = { ...baseOptions, symbols: ["SOL/INR"], barsMap: { "SOL/INR": trend() } };
    const falling = await scanAllMarkets({ ...opts, marketTrend: { regime: "trending_bearish", change1hPct: -0.4 } });
    expect(falling.outcomes).toEqual([{ symbol: "SOL/INR", proposed: false, reason: "market_down" }]);
    expect(falling.shadows.some((s) => s.kind === "market_down")).toBe(true);

    const dump = await scanAllMarkets({ ...opts, marketTrend: { regime: "neutral", change1hPct: -1.5 } });
    expect(dump.outcomes[0]).toMatchObject({ reason: "market_down" });

    const calm = await scanAllMarkets({ ...opts, marketTrend: { regime: "neutral", change1hPct: -0.3 } });
    expect(calm.outcomes).toEqual([{ symbol: "SOL/INR", proposed: true }]);
  });

  it("doesn't let a trader trade while their setups lose money with the exits", async () => {
    const opts = { ...baseOptions, symbols: ["SOL/INR"], barsMap: { "SOL/INR": trend() } };
    const free = await scanAllMarkets(opts);
    const names = [...new Set(free.shadows.map((s) => s.setupName))];
    const table = (r: number): ExpectancyTable => ({
      profile: "tight",
      measuredAt: 0,
      symbols: 5,
      byKey: Object.fromEntries(names.map((n) => [`crypto:${n}`, { trades: 40, totalR: 40 * r, wins: 20, winR: 20, lossR: -20 }])),
    });

    _resetScannedCandles();
    const losing = await scanAllMarkets({ ...opts, exitExpectancy: table(-0.2) });
    expect(losing.outcomes).toEqual([{ symbol: "SOL/INR", proposed: false, reason: "no_exit_edge" }]);

    _resetScannedCandles();
    const earning = await scanAllMarkets({ ...opts, exitExpectancy: table(0.3) });
    expect(earning.outcomes).toEqual([{ symbol: "SOL/INR", proposed: true }]);
    const proposal = earning.newProposals[0];
    expect(proposal.exitEdge).toEqual({ r: 0.25, trades: 40 }); // 12 / (40 + 8)
    expect(proposal.metaScore.confidenceRationale).toMatch(/With your exits, .* averaged \+0\.25R over 40 recent setups/);
  });
});

describe("Bitcoin's trend", () => {
  it("reads the last hour's change from 5-minute candles", () => {
    // The candle an hour before the last (12 back) at 100, the last at 98.5.
    const bars = candles(30, (i) => (i < 18 ? 100 : 98.5));
    expect(marketTrendFrom(bars, "neutral").change1hPct).toBeCloseTo(-1.5, 6);
    expect(marketTrendFrom(null, undefined)).toEqual({ regime: "neutral", change1hPct: null });
    expect(marketIsFalling({ regime: "neutral", change1hPct: -0.99 })).toBe(false);
    expect(marketIsFalling({ regime: "neutral", change1hPct: -1 })).toBe(true);
    expect(marketIsFalling({ regime: "trending_bearish", change1hPct: 0.5 })).toBe(true);
    expect(marketIsFalling(undefined)).toBe(false);
  });
});

describe("the Book's breakdown", () => {
  const t = (over: Partial<HistoricalTrade>): HistoricalTrade =>
    ({
      id: Math.random().toString(36),
      symbol: "SOL/INR",
      direction: "LONG",
      setupName: "Priya Momentum Scalp",
      entryPrice: 100,
      exitPrice: 101,
      quantity: 1,
      moneyPlaced: 100,
      realizedPnl: 0,
      realizedPnlPercent: 0,
      isWin: false,
      exitReason: "TRAILING_STOP",
      openedAt: "",
      closedAt: "",
      ...over,
    }) as HistoricalTrade;

  const trades = [
    t({ realizedPnl: 36, isWin: true, riskAtOpen: 60 }),
    t({ realizedPnl: 36, isWin: true, riskAtOpen: 60 }),
    t({ realizedPnl: -64, exitReason: "STOP_LOSS", riskAtOpen: 60, setupName: "Chen Conservative Trend", symbol: "ZEC/INR" }),
  ];

  it("shows wins against losses and the win rate that breaks even with them", () => {
    const s = payoffSummary(trades)!;
    expect(s).toMatchObject({ count: 3, winPct: 67, avgWin: 36, avgLoss: 64, breakEvenWinPct: 64 });
    // (0.6 + 0.6 − 1.0667) / 3
    expect(s.avgR).toBeCloseTo((36 / 60 + 36 / 60 - 64 / 60) / 3, 6);
    expect(payoffSummary([])).toBeNull();
  });

  it("groups by trader, coin or exit, costliest first", () => {
    const byTrader = breakdown(trades, (x) => x.setupName);
    expect(byTrader.map((r) => [r.key, r.net])).toEqual([
      ["Chen Conservative Trend", -64],
      ["Priya Momentum Scalp", 72],
    ]);
    expect(byTrader[1]).toMatchObject({ count: 2, wins: 2, avgWin: 36, avgLoss: 0 });
    // Trades from before risk was recorded don't count toward the R average.
    expect(breakdown([t({ realizedPnl: 5 })], (x) => x.symbol)[0].avgR).toBeNull();
  });

  it("records 1R when a trade closes", () => {
    expect(riskAtOpen({ entryPrice: 100, initialStopLoss: 98.5, quantity: 4 })).toBe(6);
    expect(riskAtOpen({ entryPrice: 100, quantity: 4 })).toBeUndefined();
  });
});
