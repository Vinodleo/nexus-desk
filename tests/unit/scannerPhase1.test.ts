// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { priceEntry } from "../../src/services/entryPricing";
import { _resetScannedCandles, scanAllMarkets } from "../../src/services/marketScannerService";
import { topSkipReasons } from "../../src/components/ledger/LedgerFloor";
import { addSkipCounts } from "../../src/services/scanOutcome";
import type { MarketBar } from "../../src/types";

vi.spyOn(console, "warn").mockImplementation(() => {});

describe("entry at the live price", () => {
  const setup = { symbol: "SOL/INR", direction: "LONG" as const, entryPrice: 10000, stopLoss: 9970, takeProfit: 10066 };

  it("keeps the signal's stop and target and shrinks size if the stop is further away", () => {
    const p = priceEntry(setup, 9990, 10, 300); // 20 to the stop now, budget ₹300 -> 15 units, capped at 10
    expect(p).toMatchObject({ ok: true, entryPrice: 9990, units: 10 });
    const q = priceEntry(setup, 10005, 10, 300); // 35 to the stop -> 8.57 units, floored to the step
    expect(q.ok && q.units).toBe(8.571);
  });

  it("skips a trade that has already run or already failed", () => {
    expect(priceEntry(setup, 9960, 10, 300)).toMatchObject({ ok: false, reason: expect.stringMatching(/past the stop/) });
    expect(priceEntry(setup, 10070, 10, 300)).toMatchObject({ ok: false, reason: expect.stringMatching(/reached the target/) });
    // 10040: 70 to the stop, 26 to the target; ₹10.04 of fees -> 15.96 / 80.04 = 0.20R
    expect(priceEntry(setup, 10040, 10, 300)).toMatchObject({ ok: false, reason: expect.stringMatching(/only 0.20R of reward is left after fees/) });
    // 10010 looks like 1.4R before fees but is 0.92R after them.
    expect(priceEntry(setup, 10010, 10, 300)).toMatchObject({ ok: false, reason: expect.stringMatching(/only 0.92R/) });
  });

  it("uses the signal price when there's no live price", () => {
    expect(priceEntry(setup, undefined, 5, 300)).toMatchObject({ ok: true, entryPrice: 10000, units: 5 });
  });
});

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

describe("scanner outcomes", () => {
  beforeEach(() => _resetScannedCandles());

  it("skips coins without real candles instead of generating some", async () => {
    const report = await scanAllMarkets({ ...baseOptions, symbols: ["ETH/INR"], barsMap: {} });
    expect(report.outcomes).toEqual([{ symbol: "ETH/INR", proposed: false, reason: "no_data" }]);
    expect(report.newProposals).toEqual([]);
  });

  it("says when no trader's rules matched, and scans each candle only once", async () => {
    const flat = candles(120, (i) => 10000 + (i % 2 === 0 ? 3 : -3));
    const opts = { ...baseOptions, symbols: ["SOL/INR"], barsMap: { "SOL/INR": flat }, onlyNewCandles: true };
    const first = await scanAllMarkets(opts);
    expect(first.outcomes).toEqual([{ symbol: "SOL/INR", proposed: false, reason: "no_setup" }]);
    const again = await scanAllMarkets(opts);
    expect(again.outcomes).toEqual([]); // same candle: not scanned twice
    const manual = await scanAllMarkets({ ...opts, onlyNewCandles: false });
    expect(manual.outcomes).toHaveLength(1); // "Scan now" always looks
  });

  it("proposes a clean trend and prices it from the last closed candle", async () => {
    const trend = candles(150, (i) => 10000 + i * 8);
    const report = await scanAllMarkets({ ...baseOptions, symbols: ["SOL/INR"], barsMap: { "SOL/INR": trend } });
    expect(report.outcomes).toEqual([{ symbol: "SOL/INR", proposed: true }]);
    // Every setup is handed to shadow tracking, starting at the candle close.
    expect(report.shadows.length).toBeGreaterThan(0);
    expect(report.shadows.some((s) => s.kind === "proposed")).toBe(true);
    expect(report.shadows[0].signalTime).toBe(trend[trend.length - 1].timestampMs! + FIVE_MIN);
    const p = report.newProposals[0];
    expect(p.setup.timeframe).toBe("5m");
    expect(p.setup.direction).toBe("LONG");
    expect(p.setup.entryPrice).toBe(trend[trend.length - 1].close);
    // Valid until two candles after the one it came from closed.
    const close = trend[trend.length - 1].timestampMs! + FIVE_MIN;
    expect(p.expiresAt! - (close + 2 * FIVE_MIN)).toBeLessThan(2000);
  });
});

describe("skip reason summary", () => {
  it("adds outcomes up and lists the biggest reasons first", () => {
    const counts = addSkipCounts({ no_setup: 5 }, [
      { symbol: "A", proposed: false, reason: "low_confidence" },
      { symbol: "B", proposed: false, reason: "no_setup" },
      { symbol: "C", proposed: true },
    ]);
    expect(counts).toEqual({ no_setup: 6, low_confidence: 1 });
    expect(topSkipReasons(counts)).toEqual([
      { reason: "no_setup", label: "No trader's rules matched", pct: 86 },
      { reason: "low_confidence", label: "Chance of a win too low", pct: 14 },
    ]);
  });
});

describe("no-data counting", () => {
  beforeEach(() => _resetScannedCandles());
  it("counts a coin without data once per candle on automatic scans", async () => {
    const opts = { ...baseOptions, symbols: ["ETH/INR"], barsMap: {}, onlyNewCandles: true };
    expect((await scanAllMarkets(opts)).outcomes).toHaveLength(1);
    expect((await scanAllMarkets(opts)).outcomes).toHaveLength(0);
  });
});
