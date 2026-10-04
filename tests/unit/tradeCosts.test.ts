import { describe, expect, it } from "vitest";
import type { MarketBar } from "../../src/types";
import { costShareOfStop, costsTooBigForStop, MAX_COIN_SPREAD, MAX_COST_SHARE_OF_STOP, roundTripFeeRate, spreadTooWide } from "../../src/shared/tradeCosts";
import { DEFAULT_RISK_POLICY, evaluateExpectedValue, evaluateRiskEngine } from "../../src/services/riskEngine";
import { measureExpectancy } from "../../src/services/exitExpectancy";

// Fees and the spread are paid win or lose, so a trade whose stop is only a
// few times its costs away can't pay. Such setups aren't taken live, and the
// traders' records leave them out too.

describe("costs next to the stop", () => {
  it("block an Indian stock on a 5-minute stop, but not one with room", () => {
    // About 0.27% in charges a round trip at ₹10,000 (Angel One intraday).
    expect(roundTripFeeRate("SBIN")).toBeCloseTo(0.00272, 4);
    // A 0.4% stop: costs take about 70% of it.
    expect(costShareOfStop("SBIN", 1000, 996, 0.0003)).toBeCloseTo(0.75, 1);
    expect(costsTooBigForStop("SBIN", 1000, 996, 0.0003)).toBe(true);
    expect(costsTooBigForStop("SBIN", 1000, 985, 0.0003)).toBe(false);
  });

  it("let a US stock with a tight spread through, and hold back a coin with a wide one", () => {
    expect(costsTooBigForStop("AAPL.US", 20000, 19940, 0.0002)).toBe(false); // 0.3% stop, 0.03% costs
    expect(costsTooBigForStop("SHIB/INR", 1, 0.988, 0.006)).toBe(true); // 1.2% stop, 0.7% costs
    // CoinDCX's 0.59% a side: a 1.2% stop is far too close; a daily stop of 6% has room.
    expect(costsTooBigForStop("BTC/INR", 100, 98.8, 0.0015)).toBe(true); // 1.2% stop, 1.33% costs
    expect(costsTooBigForStop("BTC/INR", 100, 94, 0.0015)).toBe(false); // 6% stop, 1.33% costs
    expect(MAX_COST_SHARE_OF_STOP).toBe(0.25);
  });

  it("make the risk check refuse a trade whose fees eat the stop, even with no spread read", () => {
    const setup: any = {
      id: "s", name: "t", family: "trend_following", direction: "LONG", symbol: "SBIN", timeframe: "5m", entryPrice: 1000,
      stopLoss: 996, takeProfit: 1012, riskRewardRatio: 3, baseProbability: 0.6, qualifies: true,
      features: { emaAlignment: true, volumeSurgeRatio: 1.5, vwapDistancePercent: 0.1, adx: 30, rsi: 55, atr: 3 },
    };
    const meta: any = { confidence: 0.7, calibratedWinProbability: 0.7 };
    const noDrills = {
      globalKillSwitchActive: false, simulateAgentTimeout: false, simulateStaleMarketData: false,
      simulateDailyLossBreach: false, simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false,
    };
    const run = (s: any) =>
      evaluateRiskEngine(s, meta, evaluateExpectedValue(s, meta, 0, 90), [], 0, 90, { ...DEFAULT_RISK_POLICY, equity: 100000 }, noDrills, false);
    const tight = run(setup);
    expect(tight.passedAllChecks).toBe(false);
    expect(tight.rejectionCode).toBe("spread");
    expect(tight.rejectionReason).toMatch(/Fees and the bid-ask spread \(0\.27% of price\) would take 68% of the stop distance/);
    expect(run({ ...setup, stopLoss: 985, takeProfit: 1045 }).rejectionCode).not.toBe("spread");
  });
});

describe("coins with a wide spread", () => {
  const coinSetup: any = {
    id: "s", name: "t", family: "trend_following", direction: "LONG", symbol: "SOL/INR", timeframe: "5m", entryPrice: 100,
    stopLoss: 90, takeProfit: 125, riskRewardRatio: 2.5, baseProbability: 0.6, qualifies: true,
    features: { emaAlignment: true, volumeSurgeRatio: 1.5, vwapDistancePercent: 0.1, adx: 30, rsi: 55, atr: 3 },
  };
  const meta: any = { confidence: 0.7, calibratedWinProbability: 0.7 };
  const noDrills = {
    globalKillSwitchActive: false, simulateAgentTimeout: false, simulateStaleMarketData: false,
    simulateDailyLossBreach: false, simulateOrderBookThinLiquidity: false, simulateConflictingSignals: false,
  };
  /** The risk check with a spread of `spread` rupees on a ₹100 price. */
  const run = (s: any, spread: number) =>
    evaluateRiskEngine(s, meta, evaluateExpectedValue(s, meta, spread, 90), [], 0, 90, DEFAULT_RISK_POLICY, noDrills, false, { spread });

  it("aren't traded above 0.2%, coins only", () => {
    expect(MAX_COIN_SPREAD).toBe(0.002);
    expect(spreadTooWide("SOL/INR", 0.0025)).toBe(true);
    expect(spreadTooWide("SOL/INR", 0.0015)).toBe(false);
    expect(spreadTooWide("SBIN", 0.005)).toBe(false);
    expect(spreadTooWide("AAPL.US", 0.005)).toBe(false);
  });

  it("are refused by the risk check even when the stop is wide enough for the costs", () => {
    // A 10% stop: 0.5% spread and fees are 6% of it, well inside the cost check.
    expect(costsTooBigForStop("SOL/INR", 100, 90, 0.005)).toBe(false);
    const wide = run(coinSetup, 0.5);
    expect(wide.passedAllChecks).toBe(false);
    expect(wide.rejectionCode).toBe("spread_cap");
    expect(wide.rejectionReason).toMatch(/spread \(0\.50% of price\) is wider than the 0\.2% coins are traded at/);
    expect(run(coinSetup, 0.1).rejectionCode).toBeUndefined();
    // An Indian stock isn't held to it, nor a swing trade (always the owner's call).
    expect(run({ ...coinSetup, symbol: "SBIN" }, 0.5).rejectionCode).not.toBe("spread_cap");
    expect(run({ ...coinSetup, horizon: "swing" }, 0.5).rejectionCode).toBeUndefined();
  });
});

describe("the traders' records", () => {
  /** A stock rising 0.15% a candle, each candle `range` wide either side, over the last 3 days. */
  const stockBars = (range: number): MarketBar[] => {
    const now = Date.parse("2026-09-23T04:32:00Z");
    const out: MarketBar[] = [];
    for (let t = now - 3 * 86_400_000; t <= now; t += 300_000) {
      const c = 905 * Math.pow(1.0015, (t - now) / 300_000);
      out.push({ time: new Date(t).toISOString(), timestampMs: t, open: c * 0.9997, high: c * (1 + range), low: c * (1 - range), close: c, volume: 50000 });
    }
    return out;
  };

  it("leave out setups whose costs would eat the stop, as the live checks do", () => {
    // Indian stocks plan 1.2%+ stops: with a normal spread their costs are about a quarter of it and they count.
    const normal = measureExpectancy([{ symbol: "SBIN", bars: stockBars(0.004) }], undefined, 0, () => 0.0002);
    expect(normal.byKey["nse:Chen Conservative Trend"]?.trades).toBeGreaterThan(0);
    // A 2% spread on top of the charges eats more than the whole stop: none counts.
    const wide = measureExpectancy([{ symbol: "SBIN", bars: stockBars(0.004) }], undefined, 0, () => 0.02);
    expect(Object.keys(wide.byKey).filter((k) => k.startsWith("nse:"))).toEqual([]);
  });

  it("leave out coins whose spread is too wide to trade", () => {
    const bars = stockBars(0.004);
    expect(measureExpectancy([{ symbol: "SOL/INR", bars }], undefined, 0, () => 0.001).symbols).toBe(1);
    expect(measureExpectancy([{ symbol: "SOL/INR", bars }], undefined, 0, () => 0.005).symbols).toBe(0);
    // Stocks aren't held to the coins' limit.
    expect(measureExpectancy([{ symbol: "SBIN", bars }], undefined, 0, () => 0.005).symbols).toBe(1);
  });
});
